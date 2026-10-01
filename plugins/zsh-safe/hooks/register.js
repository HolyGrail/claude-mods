// Lets Bash commands written the bash way run under zsh: an unmatched glob and a leading = pass
// through as text, and a command that fails for want of timeout comes back with the fix.
//
// The options come from zdotdir/.zshenv, which every zsh Claude Code starts reads once ZDOTDIR
// points there. Commands are never rewritten, so the permission rules, the auto mode classifier
// and the transcript all see the command the model wrote.

// How zsh and bash report a missing timeout: `(eval):1: command not found: timeout`,
// `bash: line 1: timeout: command not found`
const TIMEOUT_MISSING = /command not found: timeout\b|\btimeout: command not found/

export function register(on) {
  // Fires again on a reload. Sets ZDOTDIR before passing the event on, so the hooks beneath that
  // start zsh already get it
  on('session.start', async ($, e, next) => {
    const zdotdir = `${$.plugin.root}/zdotdir`
    // A reload, after an update too, finds ZDOTDIR at the folder this module set (an update
    // moves it), with the person's own value already kept
    if ((await $.env.get('ZDOTDIR')) !== (await $.env.get('ZSH_SAFE_DIR'))) {
      await $.env.set('ZSH_SAFE_ZDOTDIR', await $.env.get('ZDOTDIR'))
    }
    await $.env.set('ZSH_SAFE_DIR', zdotdir)
    await $.env.set('ZDOTDIR', zdotdir)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true || !TIMEOUT_MISSING.test(ran.text)) return ran
    const fix =
      `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
      `When the whole command may share one deadline, run it without timeout and set the Bash tool's ` +
      `timeout parameter (in milliseconds). When the deadline must cover one part only, as in ` +
      `\`timeout 5 build || cleanup\`, use \`perl -e 'alarm shift; exec @ARGV' 5 build\` instead, ` +
      `which exits 142 rather than 124 when the time runs out.`
    return { ...ran, context: [...(ran.context ?? []), fix] }
  })
}
