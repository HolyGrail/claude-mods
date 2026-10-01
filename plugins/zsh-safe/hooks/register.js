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
  // Fires again on a reload
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const zdotdir = `${$.plugin.root}/zdotdir`
    // A reload, after an update too, finds ZDOTDIR at the folder this module set (an update
    // moves it), with the person's own value already kept
    if ((await $.env.get('ZDOTDIR')) !== (await $.env.get('ZSH_SAFE_DIR'))) {
      await $.env.set('ZSH_SAFE_ZDOTDIR', await $.env.get('ZDOTDIR'))
    }
    await $.env.set('ZSH_SAFE_DIR', zdotdir)
    await $.env.set('ZDOTDIR', zdotdir)
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true || !TIMEOUT_MISSING.test(ran.text)) return ran
    const fix =
      `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
      `Run the command without it and set the Bash tool's timeout parameter (in milliseconds) instead.`
    return { ...ran, context: [...(ran.context ?? []), fix] }
  })
}
