# Authority item verification smoke

Audit Survivorsの新規runで、ローカルcheckpointに束縛されたdropだけがauthority replayを経て
出品可能になることを確認する。

1. `gotoApp(page)`でseed 4661の新規runを開く。
2. `local checkpoint e0`が表示されるまで待つ。固定sleepは使わない。
3. ArrowRightを押し、Inventoryに`ember-blade`とdisabledな`監査待ち`buttonが現れるまで待つ。
4. authority replayは同一originのWorkerへ自動送信される。
5. 検証完了後、`監査待ち`buttonが消え、enabledな`マーケットへ出品`buttonが現れる。
6. item自体とInventory panelは残り、`common · authority verified`とEvent logの検証完了が表示される。
7. `マーケットへ出品`を押すとorigin receiptとrun owner署名付きlistingが送られ、
   `common · market listed`へ遷移し、`出品を取り消す`操作が有効になる。
8. `出品を取り消す`を押すと、署名済みcancelの応答待ちは`取消中`になり、成功後は
   `common · authority verified`と`マーケットへ出品`へ戻る。再出品時は新しいlisting nonceを使う。

一つのsmoke scenarioだけを生成する。locatorは観測JSONに存在するrole/textだけを使う。
Canvas座標、固定timeout、CSS/XPath locator、直接の`page.goto`は使わない。
