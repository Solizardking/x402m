"""Durable SQLite channel accounting for a single-host reference deployment.

Atomic reservations/completions survive restarts. Running operations after a
crash stay reserved: reconcile application side effects before releasing them.
"""
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from .batch import SchemeError, amount, U64_MAX, verify_voucher, address


class ChannelStore:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        if os.fstat(descriptor).st_mode & 0o077:
            os.close(descriptor)
            raise ValueError("channel store must be private (chmod 600)")
        os.close(descriptor)
        self.db = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY, binding TEXT NOT NULL, deposit TEXT NOT NULL,
            charged TEXT NOT NULL, status TEXT NOT NULL, voucher TEXT, settled TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations (
            channel TEXT NOT NULL, request TEXT NOT NULL, ceiling TEXT NOT NULL,
            mode TEXT NOT NULL, status TEXT NOT NULL, actual TEXT, cumulative TEXT,
            PRIMARY KEY(channel,request));
          CREATE TABLE IF NOT EXISTS receiver_bindings (
            network TEXT NOT NULL, channel TEXT NOT NULL, authorizer TEXT NOT NULL,
            caller TEXT, PRIMARY KEY(network,channel));
        ''')

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def bind_receiver(self, network, channel_id, authorizer, caller=None):
        """First writer wins; successful read-back is required before broadcast."""
        address(channel_id); address(authorizer)
        with self.transaction():
            self.db.execute("INSERT OR IGNORE INTO receiver_bindings VALUES(?,?,?,?)", (network, channel_id, authorizer, caller))
            row = self.db.execute("SELECT * FROM receiver_bindings WHERE network=? AND channel=?", (network, channel_id)).fetchone()
            if row["authorizer"] != authorizer:
                raise SchemeError("receiver_authorizer_mismatch")
            if row["caller"] != caller:
                raise SchemeError("delegated_unauthenticated")
        return dict(row)

    def receiver_binding(self, network, channel_id):
        row = self.db.execute("SELECT * FROM receiver_bindings WHERE network=? AND channel=?", (network, channel_id)).fetchone()
        return dict(row) if row else None

    def register(self, channel_id, config, requirements, snapshot, *, initialize=False):
        """Caller supplies a verified fresh snapshot. Lost accounting fails closed."""
        from .batch import derive_channel_id
        if derive_channel_id(config, requirements) != channel_id or snapshot.channel_id != channel_id:
            raise SchemeError("channel_id_mismatch")
        if not 0 <= snapshot.settled <= snapshot.deposit <= U64_MAX:
            raise SchemeError("channel_state")
        if snapshot.token_program != requirements["extra"]["tokenProgram"]:
            raise SchemeError("token_program")
        binding = json.dumps({"config": config, "network": requirements["network"],
                              "feePayer": requirements["extra"]["feePayer"], "tokenProgram": snapshot.token_program}, sort_keys=True)
        with self.transaction():
            row = self.db.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone()
            if row is None:
                if initialize is not True or snapshot.settled != 0:
                    raise SchemeError("channel_state")  # Importing a recovered channel needs explicit accounting reconciliation.
                self.db.execute("INSERT INTO channels VALUES(?,?,?,?,?,NULL,?)", (channel_id, binding, str(snapshot.deposit), "0", snapshot.status, str(snapshot.settled)))
            else:
                if row["binding"] != binding or int(row["charged"]) < snapshot.settled:
                    raise SchemeError("channel_state")
                if snapshot.settled < int(row["settled"]) or snapshot.deposit < int(row["deposit"]):
                    raise SchemeError("channel_state")
                if row["status"] != "Open" and snapshot.status == "Open":
                    raise SchemeError("channel_closing")
                reserved = sum(int(item[0]) for item in self.db.execute("SELECT ceiling FROM operations WHERE channel=? AND status='running'", (channel_id,)))
                if int(row["charged"]) + reserved > snapshot.deposit:
                    raise SchemeError("cumulative_exceeds_deposit")
                self.db.execute("UPDATE channels SET deposit=?,status=?,settled=? WHERE id=?", (str(snapshot.deposit), snapshot.status, str(snapshot.settled), channel_id))

    def state(self, channel_id):
        row = self.db.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone()
        if not row:
            raise SchemeError("channel_state")
        return dict(row)

    def reserve(self, channel_id, request_id, ceiling, mode, voucher=None):
        ceiling = amount(ceiling)
        if not isinstance(request_id, str) or not 1 <= len(request_id.encode()) <= 256 or mode not in ("client", "server"):
            raise SchemeError("payload_type")
        with self.transaction():
            row = self.state(channel_id)
            if row["status"] != "Open":
                raise SchemeError("channel_closing")
            if self.db.execute("SELECT 1 FROM operations WHERE channel=? AND request=?", (channel_id, request_id)).fetchone():
                raise SchemeError("duplicate_settlement")
            configured_mode = json.loads(row["binding"])["config"].get("voucherSigner", "client")
            if mode != configured_mode:
                raise SchemeError("payload_type")
            running = self.db.execute("SELECT ceiling FROM operations WHERE channel=? AND status='running'", (channel_id,)).fetchall()
            if mode == "client":
                if running:
                    raise SchemeError("duplicate_settlement")
                config = json.loads(row["binding"])["config"]
                cumulative = verify_voucher(voucher or {}, channel_id, config["payerAuthorizer"])
                if cumulative != int(row["charged"]) + ceiling or cumulative <= int(row["charged"]):
                    raise SchemeError("cumulative_amount_mismatch")
            if int(row["charged"]) + sum(int(item[0]) for item in running) + ceiling > int(row["deposit"]):
                raise SchemeError("cumulative_exceeds_deposit")
            self.db.execute("INSERT INTO operations VALUES(?,?,?,?, 'running',NULL,NULL)", (channel_id, request_id, str(ceiling), mode))

    def complete(self, channel_id, request_id, actual, voucher=None, signer=None):
        actual = amount(actual)
        with self.transaction():
            operation = self.db.execute("SELECT * FROM operations WHERE channel=? AND request=?", (channel_id, request_id)).fetchone()
            if not operation or operation["status"] != "running":
                raise SchemeError("duplicate_settlement")
            if actual > int(operation["ceiling"]) or (operation["mode"] == "client" and actual != int(operation["ceiling"])):
                raise SchemeError("cumulative_amount_mismatch")
            row = self.state(channel_id)
            cumulative = int(row["charged"]) + actual
            if cumulative > int(row["deposit"]):
                raise SchemeError("cumulative_exceeds_deposit")
            if operation["mode"] == "server":
                if signer is None:
                    raise SchemeError("voucher_signature")
                voucher = signer(channel_id, str(cumulative))
            config = json.loads(row["binding"])["config"]
            if verify_voucher(voucher or {}, channel_id, config["payerAuthorizer"]) != cumulative:
                raise SchemeError("cumulative_amount_mismatch")
            self.db.execute("UPDATE channels SET charged=?,voucher=? WHERE id=?", (str(cumulative), json.dumps(voucher), channel_id))
            self.db.execute("UPDATE operations SET status='completed',actual=?,cumulative=? WHERE channel=? AND request=?", (str(actual), str(cumulative), channel_id, request_id))
        return {"success": True, "transaction": "", "network": json.loads(row["binding"])["network"], "amount": "",
                "extra": {"commitmentId": f"{channel_id}:{cumulative}", "chargedAmount": str(actual), "voucher": voucher,
                          "channelState": {"channelId": channel_id, "balance": row["deposit"], "totalClaimed": row["settled"],
                                           "withdrawRequestedAt": 0, "chargedCumulativeAmount": str(cumulative)}}}

    def fail(self, channel_id, request_id):
        """Release a known failed handler; preserve its single-use request ID."""
        with self.transaction():
            self.db.execute("UPDATE operations SET status='failed' WHERE channel=? AND request=? AND status='running'", (channel_id, request_id))

    def mark_closing(self, channel_id):
        with self.transaction():
            if self.db.execute("SELECT 1 FROM operations WHERE channel=? AND status='running'", (channel_id,)).fetchone():
                raise SchemeError("close_state")
            self.state(channel_id)
            self.db.execute("UPDATE channels SET status='Closing' WHERE id=?", (channel_id,))

    def close(self):
        self.db.close()
