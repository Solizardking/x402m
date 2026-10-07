<?php

declare(strict_types=1);

namespace PayKit\Tests\Protocols\X402\Exact;

use PayKit\Exception\InvalidProofException;
use PayKit\Protocols\X402\Exact\Verifier;
use PHPUnit\Framework\TestCase;
use SolanaPhpSdk\Keypair\Keypair;
use SolanaPhpSdk\Transaction\Message;
use SolanaPhpSdk\Transaction\Transaction;

/**
 * A legacy (unprefixed) Solana message, as a pre-cutover client sends, passes
 * the x402 decode boundary and is held to the same structural rules as a
 * version-0 message.
 */
final class LegacyTransactionAcceptTest extends TestCase
{
    public function testLegacyMessageIsDecodedAndVerifiedStructurally(): void
    {
        $signer = Keypair::generate();
        $message = new Message(
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 0,
            accountKeys: [$signer->getPublicKey()],
            recentBlockhash: str_repeat("\x01", 32),
            instructions: [],
        );
        $wire = base64_encode((new Transaction($message))->serialize(verifySignatures: false));
        $requirement = ['asset' => '', 'payTo' => '', 'amount' => '1', 'extra' => []];

        try {
            Verifier::verify($wire, $requirement, []);
            self::fail('expected InvalidProofException');
        } catch (InvalidProofException $e) {
            // The decode boundary accepted the legacy wire: the first
            // structural rule (instruction count) is what rejects it.
            self::assertSame('invalid_exact_svm_payload_transaction_instructions_length', $e->getMessage());
        }
    }
}
