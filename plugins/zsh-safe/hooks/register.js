// Lets Bash commands written the bash way run under zsh: an unmatched glob and a leading = pass
// through as text, and a command that fails for want of timeout comes back with the fix.
//
// The options come from zdotdir/.zshenv, which every zsh Claude Code starts reads once ZDOTDIR
// points there. Commands are never rewritten, so the permission rules, the auto mode classifier
// and the transcript all see the command the model wrote.

// How zsh and bash report a missing timeout: `(eval):1: command not found: timeout`,
// `bash: line 1: timeout: command not found`
// A name such as timeout.sh is another command, so the name must end there
const TIMEOUT_MISSING = /command not found: timeout(?=\s|$)|(^|\s)timeout: command not found/

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
    // States what holds and leaves the rewrite to the model: no stand-in keeps every form of
    // timeout's arguments (5m, 0.5, -k) and its exit status
    const fix =
      `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
      `The Bash tool's timeout parameter (in milliseconds) can stand in for it only when the deadline covers the whole command.`
    return { ...ran, context: [...(ran.context ?? []), fix] }
  })
}
