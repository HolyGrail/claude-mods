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

- **setopt の前置**：先頭に `[ -n "$ZSH_VERSION" ] && setopt nonomatch noequals; ` を付けます。zsh では、一致するファイルがない glob が bash と同じく文字列のまま渡り（`nonomatch`）、語頭の `=` がコマンドのパスに展開されなくなります（`noequals`）。bash では `setopt` が実行されず、何も変わりません。Bash ツールがどのシェルを選んだかは、実行時のシェル自身が判定します。
- **timeout**：コマンドの位置（先頭、`;` `&&` `||` `|` `(` 改行の直後）にある `timeout` を探します。シェルに `timeout` がなければ、Bash ツール自身の `timeout` パラメータを使うよう伝えて、呼び出しを拒否します。`timeout` があれば何もしません。

`timeout` の有無は、`timeout` を使うコマンドが最初に来たときに 1 回だけ調べます。
`CLAUDE_CODE_SHELL`、なければ `SHELL` のシェルをログインかつ対話のシェルとして起動するので、`.zprofile` の PATH も `.zshrc` で定義した関数も数えます。
調べられなかったときは、拒否せずにそのまま実行します。

`.zshrc` に同じ `setopt` を書いても Claude の Bash には効きます。
ただしその場合、人が普段使う対話シェルでも、一致しない glob を実行前に止める zsh の安全装置が外れます。
mod なら、効くのは Claude が呼ぶ Bash だけです。

## 権限の判定

権限の判定は、書き換えた後の `command` に対して行われます。
前置きの `[` と `setopt` はどの allow ルールにも書かれていないサブコマンドなので、`Bash(echo:*)` のような allow ルールが外れ、確認を求められます。
実際、この節の処理を外した版を `claude -p` で動かすと、`echo ===` が拒否されました。

そこで、モデルが書いたままの `command` でも判定し、次のように組み合わせます。

- どちらかの判定が拒否なら、拒否します。
- 書き換えた後の判定が確認で、書いたままの判定が許可なら、許可します。
- PreToolUse フックが確認か拒否を返したときは、書き換えた後の判定をそのまま使います。フックの確認を、ルールの許可で上書きしないためです。

auto mode の分類器とトランスクリプトの権限拒否の記録には、書き換えた後の `command` が渡ります。

## 制約

- `timeout` を探すのは字句の簡易解析です。引用符、コメント、ヒアドキュメントの本文、算術式、`[[ ]]`、配列の値にあるものは拾いません。`$(timeout ...)` と、`env timeout` や `sudo timeout` のように別のコマンドの引数として渡るものも拾わないので、そのまま実行されて失敗します。
- `timeout` を `perl -e 'alarm shift; exec @ARGV'` に置き換える方法は採っていません。時間切れの終了コードが `timeout` の 124 から SIGALRM の 142 に変わり、`5s` のような単位付きの時間や小数、`-k` / `-s` の指定も再現できないからです。
- Homebrew の `gtimeout` にも置き換えません。`timeout` を取り違えて置き換えると、変数名やヒアドキュメントで書き出すスクリプトの中身まで書き換えてしまうからです。取り違えて拒否したときの損失は、1 往復で済みます。

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
