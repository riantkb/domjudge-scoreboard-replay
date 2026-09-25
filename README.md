# DOMjudge Scoreboard Replay

DOMjudge のエクスポートから作成したデータを、任意の時刻の順位表として再生する静的 Web サイトです。

[リプレイを見る](https://riantkb.github.io/domjudge-scoreboard-replay/)

## ディレクトリ

```text
docs/                         GitHub Pages で配信するファイル
  index.html                   画面
  replay.js                    表示と順位計算
  styles.css, domjudge-match.css
  LICENSES/                    GitHub Pages で参照できる GPL の本文
  data/                        公開用 JSON と大会一覧
tools/                        データ生成とローカル確認用の Python
```

## ローカルで表示する

リポジトリのルートで次を実行し、<http://localhost:8000/> を開きます。公開用 JSON は `docs/data/` に含まれています。

```console
python3 tools/serve.py
```

ポートを変える場合は `python3 tools/serve.py --port 8080` を使います。

再生中に別のタブへ移っても時間は進みます。タブへ戻ると、その時点の順位表に更新されます。

## 大会を追加・更新する

DOMjudge のエクスポートディレクトリに `event-feed.ndjson` と `scoreboard.json` を用意し、次を実行します。

event-feed が残っていない場合は、同じエクスポートディレクトリに `contest.json`、`judgement-types.json`、`judgements.json`、`problems.json`、`scoreboard.json`、`submissions.json`、`teams.json` を用意します。

```console
python3 tools/build_replay_data.py --contest /path/to/export-directory
```

`contest.json` には contest エンドポイントと同じ階層・項目名を使います。開始・終了の実時刻は `scoreboard.json` の `state` を優先します。凍結なしは `"scoreboard_freeze_duration": null` と表します。contest の応答が別のファイル名で保存されている場合は、`--contest-json /path/to/file.json` で指定できます。これらの元データはリポジトリに追加しないでください。

大会名から ID を作り、`docs/data/<ID>.json` と `docs/data/contests.manifest.json` を更新します。大会一覧は開始日時の新しい順に並び、URL で大会を指定しなければ最新の大会を開きます。既存の大会は保持されます。`--contest` は複数回指定できます。大会名から作る ID が重複するときは `--contest ID=/path/to/export-directory` で指定してください。大会を削除するときは対応する JSON を `docs/data/` から取り除き、残す大会を指定して生成コマンドを再実行します。

公開用 JSON には表示対象チームの名前・所属、問題の表示情報、競技中の提出時刻・判定完了時刻・得点計算に必要な結果だけが入ります。元のチーム ID、提出 ID、ソースコードは含めません。未使用の初期アカウントは生成時に除外します。画面では判定済みの提出を反映し、凍結がある大会では公開順位表の凍結を切り替えられます。「判定完了」は対象提出の判定が出揃ったことを表し、DOMjudge での正式な結果確定を意味しません。

## ライセンス

本リポジトリのソースコードとドキュメントは、以下の JSON データを除き [GPL-2.0-or-later](LICENSE) で公開します。

独自に作成した部分の著作権表示: Copyright (c) 2026 rian.

`docs/domjudge-match.css` は [DOMjudge 9.0.0 の `style_domjudge.css`](https://github.com/DOMjudge/domjudge/blob/9.0.0/webapp/public/style_domjudge.css) を基に改変したものです。DOMjudge の著作権と改変の表示は CSS 冒頭に記載しています。ライセンス本文は GitHub Pages からも読めるよう、[docs/LICENSES/GPL-2.0.txt](docs/LICENSES/GPL-2.0.txt) にも置いています。

`docs/data/*.json` は GPL-2.0-or-later の対象外です。これらは大会の結果から生成した閲覧用データで、チーム名・所属・問題名・提出履歴などを含みます。データの再利用条件については、大会主催者などの権利者に確認してください。

## GitHub Pages で公開する

必要なファイルを GitHub に push した後、リポジトリの **Settings → Pages** で **Deploy from a branch**、ブランチ `main`、フォルダ `/docs` を選びます。`docs/.nojekyll` により、静的ファイルをそのまま配信します。

公開用 JSON のチーム名・所属・提出時刻は誰でも取得できます。公開前に内容と公開許可を確認してください。元の `event-feed.ndjson`、`scoreboard.json` などのエクスポート一式は Git に追加しないでください。大会一覧から外した古い JSON が `docs/data/` に残っていないことも確認してください。
