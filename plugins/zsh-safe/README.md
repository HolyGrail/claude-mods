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
- **timeout**：コマンドが `command not found: timeout` で失敗したとき、モデルにだけ見える注記を結果に添えます。`timeout` がないことと、Bash ツール自身の `timeout` パラメータで代えられるのは期限がコマンド全体にかかるときだけであることを伝え、書き直し方はモデルに任せます。コマンドの実行には手を加えません。

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

## 制約

- `zdotdir/.zshenv` の `setopt` は、利用者の `.zshenv` の後、`.zprofile` と `.zshrc` の前に実行されます。そのため、`.zshrc` で `unsetopt nonomatch` のように打ち消している環境では効きません。
- `ZDOTDIR` は、Claude Code がこのあと起動するすべての zsh に効きます。Bash ツールのほか、設定のフックから zsh を起動するスクリプトも含みます。コマンドの中でさらに起動した zsh は、元の `ZDOTDIR` に戻っているので、影響を受けません。
- mod を無効にしたりアンインストールしたりしても、そのプロセスの `ZDOTDIR` は戻りません。mods API に、アンロードを知らせるイベントがないからです。Claude Code を再起動すると戻ります。
- `timeout` の失敗は防ぎません。`make clean && timeout 30 make` なら、`make clean` は実行されたあとで止まります。mod がないときと同じ振る舞いで、変わるのは、モデルが同じ往復のうちに直し方を受け取ることです。
- 実行前にコマンドを解析して `timeout` を拒否する方法は、採っていません。字句の解析は、変数名、ヒアドキュメントの行、`case` のパターンを取り違えて、正しいコマンドを止めます。結果のエラー文を見る方法なら、`env timeout` や `$( )` の中のように表記が何であっても拾えます。
- `timeout` を書き換えることもしません。`perl -e 'alarm shift; exec @ARGV'` では、時間切れの終了コードが `timeout` の 124 から SIGALRM の 142 に変わり、`5s` のような単位付きの時間や小数、`-k` / `-s` の指定も再現できません。

## 使い方

動作を確かめたのは Claude Code v2.1.286 です。

### インストール

Claude Code のプロンプトで、次の 3 つを順に実行します。

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install zsh-safe@claude-mods
/reload-plugins
```

効き始めるのは、次に起動する zsh からです。
### 更新

marketplace の情報を取り込んでから、mod を更新します。
更新は Claude Code の再起動後に反映されます。

```bash
claude plugin marketplace update claude-mods
```

```bash
claude plugin update zsh-safe@claude-mods
```

注意点は、[リポジトリの README](../../README.md) にまとめてあります。

### インストールせずに試す

clone したリポジトリのルートで、次のように起動します。

```bash
claude --plugin-dir ./plugins/zsh-safe
```

手元のコードを常に読み込むなら、`~/.claude/settings.json` の `env` に `CLAUDE_CODE_PLUGIN_DIRS` としてこのディレクトリの絶対パスを書きます。

## テスト

```bash
cd plugins/zsh-safe
claude plugin test
```
