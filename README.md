# claude-mods

Claude Code の mod 集です。
このリポジトリ自体が plugin marketplace なので、Claude Code から直接インストールできます。

## mod 一覧

| mod | 内容 |
| --- | --- |
| [usage-meter](plugins/usage-meter/README.md) | プロンプト入力欄の上に、コンテキストと 5 時間制限・週間制限の使用率を常時表示する |
| [notice-board](plugins/notice-board/README.md) | 同じリポジトリのセッション全体にお知らせを出し、各セッションの帯とモデルに届ける |
| [pr-relay](plugins/pr-relay/README.md) | セッションの PR を監視し、マージされたときと Codex がレビューを付けたときだけセッションを起こす |

## インストール

Claude Code のプロンプトで、次の 3 つを順に実行します。

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install usage-meter@claude-mods
/reload-plugins
```

`/reload-plugins` で mod が動き始めます。
表示されないときは Claude Code を再起動してください。
mod ごとに必要な Claude Code のバージョンは、各 mod の README に書いてあります。

ターミナルからなら、次のコマンドでも同じことができます。

```bash
claude plugin marketplace add HolyGrail/claude-mods
```

```bash
claude plugin install usage-meter@claude-mods
```

Team / Enterprise プランでは、管理者が追加できる marketplace を制限していることがあります。
その場合は、管理者にこのリポジトリを許可してもらってください。

## 更新

marketplace の情報を取り込んでから、mod を更新します。
更新は Claude Code の再起動後に反映されます。

```bash
claude plugin marketplace update claude-mods
```

```bash
claude plugin update usage-meter@claude-mods
```

## 注意

mod は Claude Code と同じ権限で、サンドボックスなしに手元のマシンで動きます。
インストールする前に、`plugins/` 以下のコードに目を通してください。

## 開発

各 mod は `plugins/<name>/` にあり、ルートの `.claude-plugin/marketplace.json` に登録しています。
手元の変更を試すときは、インストールせずにディレクトリを直接読み込めます。

```bash
claude --plugin-dir ./plugins/usage-meter
```
