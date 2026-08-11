export interface InventoryOriginReceipt {
  asset_id: string;
  recipient_id: string;
  item_type: string;
  quantity: number;
  source_event: string;
  output_index: number;
}

export interface AsyncInventoryOriginDigest {
  hashString(value: string): Promise<string>;
}

export interface InventoryOriginCommitments {
  receiptDigest: string;
  lineageRoot: string;
}

function appendField(value: string): string {
  return `${value.length}:${value}`;
}

function textFieldValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

export function inventoryOriginReceiptValid(
  receipt: InventoryOriginReceipt,
): boolean {
  return typeof receipt === "object" && receipt !== null &&
    textFieldValid(receipt.asset_id) &&
    textFieldValid(receipt.recipient_id) &&
    textFieldValid(receipt.item_type) &&
    Number.isSafeInteger(receipt.quantity) && receipt.quantity > 0 &&
    textFieldValid(receipt.source_event) &&
    Number.isSafeInteger(receipt.output_index) && receipt.output_index >= 0;
}

export function canonicalInventoryItemReceipt(
  receipt: InventoryOriginReceipt,
): string {
  return [
    "item-receipt-v1",
    receipt.asset_id,
    receipt.recipient_id,
    receipt.item_type,
    receipt.quantity.toString(),
    receipt.source_event,
    receipt.output_index.toString(),
  ].map(appendField).join("");
}

export function canonicalInventoryOriginReceipt(
  receipt: InventoryOriginReceipt,
): string {
  return [
    "inventory-origin-receipt-v1",
    canonicalInventoryItemReceipt(receipt),
  ].map(appendField).join("");
}

export function canonicalInventoryOriginLineage(receiptDigest: string): string {
  return [
    "inventory-origin-lineage-v1",
    receiptDigest,
  ].map(appendField).join("");
}

export async function inventoryOriginCommitments(
  receipt: InventoryOriginReceipt,
  digest: AsyncInventoryOriginDigest,
): Promise<InventoryOriginCommitments> {
  const receiptDigest = await digest.hashString(
    canonicalInventoryOriginReceipt(receipt),
  );
  const lineageRoot = await digest.hashString(
    canonicalInventoryOriginLineage(receiptDigest),
  );
  return { receiptDigest, lineageRoot };
}
