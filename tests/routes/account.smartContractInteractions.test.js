/**
 * tests/routes/account.smartContractInteractions.test.js
 *
 * Unit tests for GET /account/:id/smart-contract-interactions
 *
 *   1. An account with 3 contract interactions returns all three.
 *   2. ?limit=2 returns only 2 interactions plus a cursor.
 *   3. An account with no Soroban interactions returns an empty array.
 *   4. Each interaction has all five required fields.
 *   5. A non-existent account returns 404.
 *
 * server.operations() is mocked with a mix of invoke_host_function and
 * classic operations so the route's type filtering is exercised.
 */

"use strict";

const request = require("supertest");
const { Keypair, StrKey, Address, xdr } = require("@stellar/stellar-sdk");

jest.mock("../../src/config/stellar", () => {
  const original = jest.requireActual("../../src/config/stellar");
  return {
    ...original,
    server: {
      operations: jest.fn(),
    },
  };
});

const app = require("../../src/index");
const { server } = require("../../src/config/stellar");

const ACCOUNT_ID = Keypair.random().publicKey();
const OTHER_ID = Keypair.random().publicKey();

const CONTRACT_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const CONTRACT_B = StrKey.encodeContract(Buffer.alloc(32, 2));
const CONTRACT_C = StrKey.encodeContract(Buffer.alloc(32, 3));

const REQUIRED_FIELDS = [
  "contractId",
  "functionName",
  "transactionHash",
  "timestamp",
  "successful",
];

let tokenSeq = 0;

function invokeOp({ contractId, fn, successful = true }) {
  const seq = ++tokenSeq;
  return {
    id: String(seq),
    paging_token: `token_${seq}`,
    type: "invoke_host_function",
    source_account: ACCOUNT_ID,
    transaction_successful: successful,
    transaction_hash: `hash_${seq}`.padEnd(64, "0"),
    created_at: "2026-10-01T12:00:00Z",
    function: "HostFunctionTypeHostFunctionTypeInvokeContract",
    parameters: [
      { type: "Address", value: new Address(contractId).toScVal().toXDR("base64") },
      { type: "Sym", value: xdr.ScVal.scvSymbol(fn).toXDR("base64") },
    ],
  };
}

function paymentOp() {
  const seq = ++tokenSeq;
  return {
    id: String(seq),
    paging_token: `token_${seq}`,
    type: "payment",
    source_account: ACCOUNT_ID,
    transaction_successful: true,
    transaction_hash: `hash_${seq}`.padEnd(64, "0"),
    created_at: "2026-10-01T12:00:00Z",
    asset_type: "native",
    from: ACCOUNT_ID,
    to: OTHER_ID,
    amount: "10.0000000",
  };
}

function mockOperations(records) {
  const builder = {
    forAccount: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    cursor: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records }),
  };
  server.operations.mockReturnValue(builder);
  return builder;
}

describe("GET /account/:id/smart-contract-interactions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns all three contract interactions and filters out classic operations", async () => {
    const builder = mockOperations([
      invokeOp({ contractId: CONTRACT_A, fn: "transfer" }),
      paymentOp(),
      invokeOp({ contractId: CONTRACT_B, fn: "swap" }),
      paymentOp(),
      invokeOp({ contractId: CONTRACT_C, fn: "deposit" }),
    ]);

    const res = await request(app).get(
      `/account/${ACCOUNT_ID}/smart-contract-interactions`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(builder.forAccount).toHaveBeenCalledWith(ACCOUNT_ID);

    const { interactions } = res.body.data;
    expect(interactions).toHaveLength(3);
    expect(interactions.map((i) => i.contractId)).toEqual([
      CONTRACT_A,
      CONTRACT_B,
      CONTRACT_C,
    ]);
    expect(interactions.map((i) => i.functionName)).toEqual([
      "transfer",
      "swap",
      "deposit",
    ]);
    expect(res.body.data.cursor).toBeNull();
  });

  it("?limit=2 returns only 2 interactions with a cursor", async () => {
    const first = invokeOp({ contractId: CONTRACT_A, fn: "transfer" });
    const second = invokeOp({ contractId: CONTRACT_B, fn: "swap" });
    const third = invokeOp({ contractId: CONTRACT_C, fn: "deposit" });
    mockOperations([first, paymentOp(), second, third]);

    const res = await request(app).get(
      `/account/${ACCOUNT_ID}/smart-contract-interactions?limit=2`,
    );

    expect(res.status).toBe(200);
    const { interactions, cursor, limit } = res.body.data;
    expect(limit).toBe(2);
    expect(interactions).toHaveLength(2);
    expect(interactions[0].contractId).toBe(CONTRACT_A);
    expect(interactions[1].contractId).toBe(CONTRACT_B);
    expect(cursor).toBe(second.paging_token);
  });

  it("returns an empty interactions array when the account has no Soroban activity", async () => {
    mockOperations([paymentOp(), paymentOp()]);

    const res = await request(app).get(
      `/account/${ACCOUNT_ID}/smart-contract-interactions`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.interactions).toEqual([]);
    expect(res.body.data.cursor).toBeNull();
  });

  it("each interaction includes all five required fields", async () => {
    const ok = invokeOp({ contractId: CONTRACT_A, fn: "transfer" });
    const failed = invokeOp({ contractId: CONTRACT_B, fn: "swap", successful: false });
    mockOperations([ok, failed]);

    const res = await request(app).get(
      `/account/${ACCOUNT_ID}/smart-contract-interactions`,
    );

    expect(res.status).toBe(200);
    const { interactions } = res.body.data;
    expect(interactions).toHaveLength(2);

    for (const interaction of interactions) {
      for (const field of REQUIRED_FIELDS) {
        expect(interaction).toHaveProperty(field);
      }
      expect(typeof interaction.contractId).toBe("string");
      expect(typeof interaction.functionName).toBe("string");
      expect(typeof interaction.transactionHash).toBe("string");
      expect(new Date(interaction.timestamp).toISOString()).toBe(interaction.timestamp);
      expect(typeof interaction.successful).toBe("boolean");
    }

    expect(interactions[0].transactionHash).toBe(ok.transaction_hash);
    expect(interactions[0].successful).toBe(true);
    expect(interactions[1].successful).toBe(false);
  });

  it("returns 404 for a non-existent account", async () => {
    const error = new Error("Not Found");
    error.response = { status: 404 };
    server.operations.mockReturnValue({
      forAccount: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      call: jest.fn().mockRejectedValue(error),
    });

    const res = await request(app).get(
      `/account/${ACCOUNT_ID}/smart-contract-interactions`,
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
