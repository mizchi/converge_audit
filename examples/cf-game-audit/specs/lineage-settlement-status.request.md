# Lineage settlement status recovery

Audit Survivors の inventory で、アイテムの中央監査状態をプレイヤーが
誤解なく確認できること。

1. drop直後は `provisional` で、authority検証が終わるまで出品できない。
2. authority検証後は `finalized` となり、出品操作が可能になる。
3. 出品時にlineage取消が返った場合は `quarantined · appeal open` を表示し、
   出品ではなく状態再確認だけを可能にする。
4. 再確認中は二重送信できず、期限切れなら `expired · listing blocked` を表示する。
5. 異議申立てが受理されて再確認結果が `finalized` になれば、再び出品可能になる。

常時pollingは使わない。既存の出品応答と、隔離後にプレイヤーが明示的に行う
単一assetのGETだけで状態を更新する。
