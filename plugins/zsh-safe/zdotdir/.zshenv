# zsh-safe points ZDOTDIR here for the shells Claude Code starts, so every zsh it runs reads this
# file first. Hand ZDOTDIR back before anything else, so the person's own startup files load from
# where they always do, then make unmatched globs and a leading = behave as in bash.
# An empty ZDOTDIR is not an unset one (zsh reads the startup files from / then), so this keys on
# whether the kept value exists at all.
if (( ${+ZSH_SAFE_ZDOTDIR} )); then
  ZDOTDIR=$ZSH_SAFE_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -f ${ZDOTDIR-$HOME}/.zshenv ]]; then
  builtin source ${ZDOTDIR-$HOME}/.zshenv
fi
# null_glob and csh_null_glob take precedence over nonomatch, dropping an unmatched glob or
# failing on it, so they go off too
builtin setopt nonomatch noequals
builtin unsetopt null_glob csh_null_glob
