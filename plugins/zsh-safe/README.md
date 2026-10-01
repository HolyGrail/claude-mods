# zsh-safe

Claude が bash の書き方で書いた Bash コマンドを、macOS の zsh でもそのまま通す Claude Code の mod です。

```text
$ zsh -c 'grep -r --include=*.ts foo .'
zsh:1: no matches found: --include=*.ts
```

モデルは失敗を見て引用を足し、再実行します。
結果は最終的に得られますが、そのたびに tool 呼び出しが 1 往復増え、エラー出力がコンテキストに残ります。

## 何をするか

- **zsh のオプション**：Claude Code が起動する zsh で `setopt nonomatch noequals` を有効にします。一致するファイルがない glob は bash と同じく文字列のまま渡り（`nonomatch`）、語頭の `=` はコマンドのパスに展開されなくなります（`noequals`）。
- **timeout**：コマンドの位置（先頭、`;` `&&` `||` `|` `(` 改行の直後）にある `timeout` を探します。シェルに `timeout` がなければ、Bash ツール自身の `timeout` パラメータを使うよう伝えて、呼び出しを拒否します。`timeout` があれば何もしません。

## 仕組み

zsh は、起動のたびに `$ZDOTDIR/.zshenv` を読みます。
この mod はセッションの開始時に、Claude Code のプロセスの環境変数 `ZDOTDIR` を、mod に同梱した `zdotdir/` に向けます。
`zdotdir/.zshenv` は最初に `ZDOTDIR` を元の値に戻し（元が未設定なら未設定に戻し）、利用者の `.zshenv` を読んでから `setopt` します。
`.zprofile` や `.zshrc` も、戻した `ZDOTDIR` から、これまでどおり読まれます。

効くのは Claude Code が起動するシェルだけです。
`.zshrc` に同じ `setopt` を書いても Claude の Bash には効きますが、その場合は人が普段使う対話シェルでも、一致しない glob を実行前に止める zsh の安全装置が外れます。

コマンドの文字列は書き換えません。
権限の判定、auto mode の分類器、トランスクリプトは、どれもモデルが書いたままのコマンドを見ます。
コマンドの先頭に `setopt …;` を付ける方法では、`Bash(echo:*)` のような allow ルールが `setopt` というサブコマンドに当たらずに外れます（`claude -p` で、`echo ===` が拒否されることを確かめました）。

`timeout` の有無は、`timeout` を使うコマンドが最初に来たときに 1 回だけ調べます。
`CLAUDE_CODE_SHELL`、なければ `SHELL` のシェルを、ログインかつ対話のシェルとして起動するので、`.zprofile` の PATH も `.zshrc` で定義した関数も数えます。
そのシェルが zsh でも bash でもないとき、または調べられなかったときは、拒否せずにそのまま実行します。

## 制約

- `zdotdir/.zshenv` の `setopt` は、利用者の `.zshenv` の後、`.zprofile` と `.zshrc` の前に実行されます。そのため、`.zshrc` で `unsetopt nonomatch` のように打ち消している環境では効きません。
- `ZDOTDIR` は、Claude Code がこのあと起動するすべての zsh に効きます。Bash ツールのほか、設定のフックから zsh を起動するスクリプトも含みます。コマンドの中でさらに起動した zsh は、元の `ZDOTDIR` に戻っているので、影響を受けません。
- `timeout` を探すのは字句の簡易解析です。引用符、`$( )`、コメント、ヒアドキュメントの本文、算術式、`[[ ]]`、`case` 文、配列の値の中にあるものは拾いません。`env timeout` や `sudo timeout` のように別のコマンドの引数として渡るものも拾わないので、そのまま実行されて失敗します。
- `timeout` を書き換えることはしません。`perl -e 'alarm shift; exec @ARGV'` では、時間切れの終了コードが `timeout` の 124 から SIGALRM の 142 に変わり、`5s` のような単位付きの時間や小数、`-k` / `-s` の指定も再現できません。Homebrew の `gtimeout` への置き換えも、解析が変数名やヒアドキュメントの行を取り違えたときに、その中身を書き換えてしまいます。取り違えて拒否したときの損失は、1 往復で済みます。

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
