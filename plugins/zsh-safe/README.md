# zsh-safe

Claude が bash の書き方で書いた Bash コマンドを、macOS の zsh でもそのまま通す Claude Code の mod です。

```text
$ zsh -c 'grep -r --include=*.ts foo .'
zsh:1: no matches found: --include=*.ts
```

モデルは失敗を見て引用を足し、再実行します。
結果は最終的に得られますが、そのたびに tool 呼び出しが 1 往復増え、エラー出力がコンテキストに残ります。

## 書き換え

Bash ツールの呼び出しを受け、`command` を書き換えてから実行します。

- **setopt の前置**：Bash ツールのシェルが zsh のとき、先頭に `setopt nonomatch noequals; ` を付けます。一致するファイルがない glob は、bash と同じく文字列のまま渡ります（`nonomatch`）。語頭の `=` は、コマンドのパスに展開されなくなります（`noequals`）。
- **timeout**：コマンドの位置（先頭と `;` `&&` `||` `|` 改行の直後）にある `timeout` を扱います。`timeout` が使えるなら何もしません。`gtimeout`（Homebrew の coreutils）だけがあれば、`gtimeout` に置き換えます。どちらもなければ、Bash ツール自身の `timeout` パラメータを使うよう伝えて、呼び出しを拒否します。

シェルは `CLAUDE_CODE_SHELL`、なければ `SHELL` で判定します。
`timeout` と `gtimeout` の有無は、`timeout` を使うコマンドが最初に来たときに、そのシェルをログインシェルとして起動して調べます。

`.zshrc` に同じ `setopt` を書いても Claude の Bash には効きます。
ただしその場合、人が普段使う対話シェルでも、一致しない glob を実行前に止める zsh の安全装置が外れます。
mod なら、効くのは Claude が呼ぶ Bash だけです。

## 権限の判定

権限の判定は、書き換えた後の `command` に対して行われます。
`setopt nonomatch noequals; echo ===` は `setopt` というサブコマンドを含むので、`Bash(echo:*)` のような allow ルールに当たらず、確認を求められます。
実際、この節の処理を外した版を `claude -p` で動かすと、`echo ===` が拒否されました。

`timeout` を `gtimeout` に置き換えたときも同じで、`Bash(timeout:*)` は `gtimeout` に当たりません。

そこで、書き換えた `command` の判定が「確認を求める」になったときだけ、モデルが書いたままの `command` で判定し直し、その結果を使います。
どちらかの判定が拒否なら、拒否のままです。

auto mode の分類器とトランスクリプトの権限拒否の記録には、書き換えた後の `command` が渡ります。

## 制約

- `timeout` は、引用符の中、コメント、ヒアドキュメントの本文にあるものを拾いません。引用符の中の `$(timeout ...)` と、`env timeout` や `sudo timeout` のように別のコマンドの引数として渡るものも拾わないので、そのまま実行されて失敗します。
- `timeout` を `perl -e 'alarm shift; exec @ARGV'` に置き換える方法は採っていません。時間切れの終了コードが `timeout` の 124 から SIGALRM の 142 に変わり、`5s` のような単位付きの時間や小数、`-k` / `-s` の指定も再現できないからです。

## 使い方

1 回だけ試すなら、ターミナルで次のように起動します。

```bash
claude --plugin-dir ./plugins/zsh-safe
```

常に読み込むなら、`~/.claude/settings.json` の `env` に `CLAUDE_CODE_PLUGIN_DIRS` としてこのディレクトリの絶対パスを書きます。

## テスト

```bash
cd plugins/zsh-safe
claude plugin test
```
