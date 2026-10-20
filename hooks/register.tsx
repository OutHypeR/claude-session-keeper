import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'

// ---- Tuning: change these numbers to taste -------------------------------
const MIN = 60 * 1000
const CACHE_TTL_MS = 60 * MIN // the 1-hour prompt cache
const PING_EVERY_MS = 58 * MIN // keep-warm period
const MAX_PINGS_IN_A_ROW = 8 // then let the cache lapse; any real turn resets it
const MIN_TOKENS_TO_PING = 20_000 // not worth warming a tiny context
const MIN_TOKENS_TO_CLEAR = 30_000 // never clear a small context
const COLD_FACTOR = 0.6 // cache lapsed: the next turn re-bills everything, so clear sooner
const RETRY_AFTER_FAIL_MS = 30 * MIN
const WRITE_TIMEOUT_MS = 15 * MIN // give up on a handover note that never appears
const COOLDOWN_AFTER_CLEAR_MS = 10 * MIN // never hand over twice back to back
const CHECK_EVERY_MS = MIN

type Limits = { tokens: number; turns: number }

// Bigger, pricier models hand over sooner.
const limitsFor = (model: string, _window: number): Limits => {
  const m = model.toLowerCase()
  const base: Limits = /fable|opus/.test(m)
    ? { tokens: 350_000, turns: 60 }
    : /sonnet/.test(m)
      ? { tokens: 500_000, turns: 100 }
      : /haiku/.test(m)
        ? { tokens: 500_000, turns: 150 }
        : { tokens: 150_000, turns: 80 }
  return base // no cap from the context window; Claude Code's own compaction still applies when the window fills
}

type Verdict = {
  clear: boolean
  why: string
  model: string
  tokens: number
  turns: number
  ageMin: number
  limits: Limits
  cold: boolean
}

const assess = async ($: EngineInterface, lastTouch: number): Promise<Verdict> => {
  const [usage, model, turns, now] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.turns(),
    $.clock.now(),
  ])
  const tokens = usage.context.tokens ?? 0
  const ageMs = Math.max(0, now - lastTouch)
  const cold = ageMs > CACHE_TTL_MS && tokens >= MIN_TOKENS_TO_CLEAR
  const base = limitsFor(model, usage.context.window)
  const k = cold ? COLD_FACTOR : 1
  const limits: Limits = { tokens: Math.round(base.tokens * k), turns: Math.round(base.turns * k) }
  const out = { model, tokens, turns, ageMin: Math.round(ageMs / MIN), limits, cold }
  const tag = cold ? ' (cache cold)' : ''

  if (tokens < MIN_TOKENS_TO_CLEAR) return { ...out, clear: false, why: 'context is small' }
  if (tokens >= limits.tokens) {
    return { ...out, clear: true, why: `${Math.round(tokens / 1000)}k tokens >= ${Math.round(limits.tokens / 1000)}k${tag}` }
  }
  if (turns >= limits.turns) return { ...out, clear: true, why: `${turns} turns >= ${limits.turns}${tag}` }
  return { ...out, clear: false, why: 'within limits' }
}

const summary = (v: Verdict) =>
  `${v.model}: ${Math.round(v.tokens / 1000)}k of ${Math.round(v.limits.tokens / 1000)}k tokens, ` +
  `${v.turns} of ${v.limits.turns} turns, cache ${v.cold ? 'cold' : 'warm'} (${v.ageMin} min since the last reply). ` +
  `${v.clear ? 'Should clear' : 'Keep going'}: ${v.why}.`

const handoverPrompt = (path: string, why: string) =>
  [
    `This session is about to be cleared and resumed from a handover note (session-keeper: ${why}). Write that note now to: ${path}`,
    '',
    'Create the folder if needed. Make it complete enough that a fresh session with no memory of this one can carry on:',
    '1. The goal and what the user asked for, in their words where it matters.',
    '2. What is done: files changed or created (full paths), commands run, results.',
    '3. Decisions made and the reason for each, plus alternatives rejected.',
    '4. Current state: what works, what is broken or unverified, anything half-finished.',
    '5. Next steps, in order, and any open questions for the user.',
    '6. Rules or preferences the user gave that still apply.',
    'Never put keys, tokens or passwords in it. When the file is written, reply with only: Handover written.',
  ].join('\n')

const resumePrompt = (path: string) =>
  `This is a continuation. Your previous session was cleared on purpose and left a handover note at ${path}. ` +
  'Read it in full, then give me two lines: the goal as you understand it and the next step you will take. Then carry on.'

// Mutable state lives at the top level so the helpers below can take `$`.
// A hot reload resets it, so phase and path are mirrored into the session's own state (see
// setPhase / restorePhase) and a reload mid-handover still finishes the clear.
const S = {
  lastTouch: Date.now(),
  isWorking: false,
  phase: 'idle' as 'idle' | 'writing' | 'clearing',
  handoverPath: '',
  writingSince: 0,
  isHandoverRunning: false, // the handover prompt's own turn has started (it can wait in the queue first)
  holdUntil: 0,
  pings: 0,
  isPingFailureShown: false,
}

const view = atom({ plugin: 'session-keeper', key: 'view' } as const, null)
// Handover phase, kept in the SESSION's own state. It must not go in $.store: that is shared by
// every open session, so one session's handover made the others clear and resume from its note.
const phaseAtom = atom({ plugin: 'session-keeper', key: 'phase' } as const, '')

const setPhase = async ($: EngineInterface, phase: typeof S.phase, path = S.handoverPath) => {
  S.phase = phase
  S.handoverPath = path
  await update($, phaseAtom, () => (phase === 'idle' ? '' : `${phase}|${path}`))
}

const restorePhase = async ($: EngineInterface) => {
  if (S.phase !== 'idle') return
  const saved = String((await read($, phaseAtom)) ?? '')
  const [phase, ...rest] = saved.split('|')
  if (phase === 'writing') {
    S.phase = phase
    S.handoverPath = rest.join('|')
    S.writingSince = await $.clock.now() // the start time was lost with the reload; count from now
  } else if (phase === 'clearing') {
    await update($, phaseAtom, () => '') // a reload hit mid-clear; the clear itself is done by now
  }
}

const isAway = async ($: EngineInterface) => (await $.store.get('away')) === true

// On unless switched off with /autoclear off. Only the automatic clear is gated; /handover now still works.
const isAutoclear = async ($: EngineInterface) => (await $.store.get('autoclear')) !== false

// What the row above the prompt draws; written from timers and handlers only.
const refreshView = async ($: EngineInterface) => {
  const [v, away, autoclear, now] = await Promise.all([assess($, S.lastTouch), isAway($), isAutoclear($), $.clock.now()])
  const idle = now - S.lastTouch
  const next: View = {
    cold: v.cold || idle > CACHE_TTL_MS,
    ageMin: v.ageMin,
    nextPingMin: away || S.pings >= MAX_PINGS_IN_A_ROW ? null : Math.max(0, Math.ceil((PING_EVERY_MS - idle) / MIN)),
    away,
    autoclear,
    tokens: v.tokens,
    tokenLimit: v.limits.tokens,
    turns: v.turns,
    turnLimit: v.limits.turns,
    isWriting: S.phase !== 'idle',
  }
  const prev = await read($, view)
  if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) await update($, view, () => next)
}

const startHandover = async ($: EngineInterface, why: string) => {
  if (S.phase !== 'idle' || S.isWorking) return
  const [cwd, now] = await Promise.all([$.session.cwd(), $.clock.now()])
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  S.handoverPath = `${cwd.split('\\').join('/')}/.claude/handovers/${stamp}.md`
  S.writingSince = now
  S.isHandoverRunning = false
  await setPhase($, 'writing', S.handoverPath)
  $.ui.toast(`session-keeper: writing a handover (${why})`)
  const sent = await $.prompt.submit({ text: handoverPrompt(S.handoverPath, why), asUser: true })
  if (sent.drop) {
    await setPhase($, 'idle')
    S.holdUntil = now + RETRY_AFTER_FAIL_MS
    $.ui.toast(`session-keeper: handover not sent: ${sent.drop}`)
  }
}

const finishHandover = async ($: EngineInterface) => {
  const path = S.handoverPath
  const now = await $.clock.now()
  if (!(await $.fs.exists(path))) {
    // Another turn can finish before the handover prompt runs (a message or a background task's
    // notice queued ahead of it, and that turn can outlast the timeout). That is not the handover
    // turn: the handover prompt is next, so restart the clock and keep waiting for the note.
    if (!S.isHandoverRunning) {
      S.writingSince = now
      return
    }
    if (now - (S.writingSince || now) < WRITE_TIMEOUT_MS) return
    await setPhase($, 'idle')
    S.holdUntil = now + RETRY_AFTER_FAIL_MS
    $.ui.toast('session-keeper: no handover file was written, so I did not clear. Will retry in 30 min.')
    return
  }
  await setPhase($, 'clearing')
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    await setPhase($, 'idle')
    S.holdUntil = now + RETRY_AFTER_FAIL_MS
    $.ui.toast(`session-keeper: could not run /clear (${String(err)}). The handover is at ${path}`)
    return
  }
  S.lastTouch = await $.clock.now()
  S.pings = 0
  S.holdUntil = S.lastTouch + COOLDOWN_AFTER_CLEAR_MS
  await setPhase($, 'idle')
  const sent = await $.prompt.submit({ text: resumePrompt(path), asUser: true })
  if (sent.drop) {
    $.ui.toast(`session-keeper: cleared, but the resume prompt was not sent (${sent.drop}). Handover: ${path}`)
  }
}

// One check a minute. Ping when 58 minutes have passed with no activity; if the
// cache already lapsed while you were away and the context is big, hand over
// instead of paying to re-read it all.
const tick = async ($: EngineInterface) => {
  await restorePhase($)
  await refreshView($)
  const now = await $.clock.now()
  if (S.phase === 'writing' && !S.isWorking && S.writingSince && now - S.writingSince >= WRITE_TIMEOUT_MS) {
    return finishHandover($) // the note never came: give up and say so
  }
  if (S.phase !== 'idle' || S.isWorking) return
  const idle = now - S.lastTouch

  if (idle > CACHE_TTL_MS && now >= S.holdUntil && (await isAutoclear($))) {
    const v = await assess($, S.lastTouch)
    if (v.clear) return startHandover($, v.why)
  }

  if (idle >= PING_EVERY_MS && S.pings < MAX_PINGS_IN_A_ROW && !(await isAway($))) {
    const { context } = await $.session.usage()
    if ((context.tokens ?? 0) < MIN_TOKENS_TO_PING) return
    const r = await $.model.fork({ prompt: 'Keep-alive ping. Reply with the single word: ok' })
    if (r.isAnswered) {
      S.pings += 1
      S.lastTouch = await $.clock.now()
      S.isPingFailureShown = false
    } else if (r.reason !== 'nothing-to-fork' && !S.isPingFailureShown) {
      S.isPingFailureShown = true
      $.ui.toast(`session-keeper: keep-warm ping failed (${r.reason})`)
    }
  }
}

const onTurnComplete = async ($: EngineInterface) => {
  S.isWorking = false
  S.lastTouch = await $.clock.now()
  S.pings = 0
  await restorePhase($)
  await refreshView($)
  if (S.phase === 'writing') {
    // Let the turn close before clearing under it.
    $.clock.after(1500, () => void finishHandover($).catch(() => {}))
  } else if (S.phase === 'idle' && S.lastTouch >= S.holdUntil && (await isAutoclear($))) {
    const v = await assess($, S.lastTouch)
    if (v.clear) await startHandover($, v.why)
  }
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    S.isWorking = true
    if (S.phase === 'writing' && S.handoverPath && e.text.includes(S.handoverPath)) {
      // The timeout counts from here, not from when the prompt was queued.
      S.isHandoverRunning = true
      S.writingSince = await $.clock.now()
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void onTurnComplete($).catch(() => {}) // a subagent's turn is not the session's
    return result
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S.lastTouch = await $.clock.now()
    $.clock.every(CHECK_EVERY_MS, () => void tick($).catch(() => {}))

    try {
      await $.command.register({
        name: 'away',
        description: 'Away mode: stop the 58-minute keep-warm ping. /away on, /away off, or /away to toggle',
      })
      await $.command.register({
        name: 'autoclear',
        description: 'Let the session hand over and clear by itself when it gets big. /autoclear on, /autoclear off, or /autoclear to toggle',
      })
      await $.command.register({
        name: 'handover',
        description: 'Show why this session would or would not clear; /handover now writes a handover and clears',
      })
    } catch (err) {
      $.ui.toast(`session-keeper: commands not registered (${String(err)})`)
    }
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Draw beneath first, so the usage meter's band stays and this row sits with it.
    const below = await next(e)
    const v = await read($, view)
    if (e.props.hasSurvey || !v) return below

    const { Box, Text } = $.ui.resolve(e)
    const k = (n: number) => `${Math.round(n / 1000)}k`
    const near = v.tokens >= v.tokenLimit * 0.8 || v.turns >= v.turnLimit * 0.8
    const row = (
      <Box columnGap={2} paddingX={1}>
        <Text dimColor>keeper</Text>
        <Text color={v.cold ? 'red' : 'green'}>{v.cold ? `cache cold ${v.ageMin}m` : `cache warm ${v.ageMin}m`}</Text>
        <Text color={v.away ? 'yellow' : undefined} dimColor={!v.away}>
          {v.away ? 'away: no pings' : v.nextPingMin === null ? 'ping paused' : `ping in ${v.nextPingMin}m`}
        </Text>
        <Text color={near ? 'yellow' : undefined} dimColor={!near}>
          {`${v.autoclear ? 'clears' : 'would clear'} at ${k(v.tokenLimit)} / ${v.turnLimit} turns (now ${k(v.tokens)} / ${v.turns})`}
        </Text>
        {!v.autoclear && <Text color="yellow">autoclear off</Text>}
        {v.isWriting && <Text color="cyan">handover in progress</Text>}
      </Box>
    )

    return below ? (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    ) : (
      row
    )
  })

  on('command.run', { command: 'away' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = arg === 'on' ? true : arg === 'off' ? false : !(await isAway($))
    await $.store.set('away', now)
    await refreshView($)
    return {
      text: now
        ? 'Away mode ON: no keep-warm pings. The cache will lapse after an hour; a big session may hand over and clear on its own.'
        : `Away mode OFF: pinging every ${PING_EVERY_MS / MIN} minutes while idle.`,
    }
  })

  on('command.run', { command: 'autoclear' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = arg === 'on' ? true : arg === 'off' ? false : !(await isAutoclear($))
    await $.store.set('autoclear', now)
    await refreshView($)
    return {
      text: now
        ? 'Autoclear ON: a big or cold session hands over and clears by itself.'
        : 'Autoclear OFF: the session never clears by itself. /handover now still works, and keep-warm pings are unchanged.',
    }
  })

  on('command.run', { command: 'handover' }, async ($, e) => {
    const v = await assess($, S.lastTouch)
    if (e.args.trim().toLowerCase() === 'now') {
      if (S.phase !== 'idle' || S.isWorking) return { text: 'Busy: wait for the current turn or handover to finish.' }
      void startHandover($, 'asked by you')
      return { text: `Writing a handover, then clearing. ${summary(v)}` }
    }
    const away = (await isAway($)) ? 'away mode on' : `pinging every ${PING_EVERY_MS / MIN} min`
    const auto = (await isAutoclear($)) ? 'autoclear on' : 'autoclear off'
    return { text: `${summary(v)} (${away}, ${auto}, ${S.pings} ping${S.pings === 1 ? '' : 's'} since the last reply)` }
  })
}
