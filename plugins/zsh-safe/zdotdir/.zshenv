# zsh-safe points ZDOTDIR here for the shells Claude Code starts, so every zsh it runs reads this
# file first. Hand ZDOTDIR back before anything else, so the person's own startup files load from
# where they always do, then make unmatched globs and a leading = behave as in bash.
if [[ -n ${ZSH_SAFE_ZDOTDIR-} ]]; then
  ZDOTDIR=$ZSH_SAFE_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -f ${ZDOTDIR:-$HOME}/.zshenv ]]; then
  builtin source ${ZDOTDIR:-$HOME}/.zshenv
fi
builtin setopt nonomatch noequals
