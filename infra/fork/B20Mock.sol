// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Stand-in for a Coinbase B20 tokenised equity, for local fork testing only.
 *
 * The real tokens are NOT EVM contracts. Their onchain code is the single byte 0xef — reserved
 * by EIP-3541 so that nothing ordinary can start with it — because the logic lives inside Base's
 * execution client as a native precompile. Anvil runs revm, not op-geth, so a mainnet fork
 * reports OpcodeNotFound the moment anything touches one. Everything else the strategy path
 * depends on (USDC, the Chainlink feeds, Aerodrome's factory/router/quoter, and Coinbase's
 * SpendPermissionManager) IS ordinary EVM code and survives the fork intact.
 *
 * So the token is the only thing replaced. `symbol` is an immutable, which lives in the deployed
 * bytecode rather than in storage, so `anvil_setCode` alone carries the identity across to the
 * B20 address — no storage reconstruction, and the address book needs no test-only branch.
 */
contract B20Mock {
    bytes32 private immutable _sym;
    uint8 public constant decimals = 8;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(bytes32 s) {
        _sym = s;
    }

    function symbol() public view returns (string memory) {
        bytes memory out = new bytes(32);
        uint256 n;
        for (uint256 i; i < 32; ++i) {
            if (_sym[i] == 0) break;
            out[i] = _sym[i];
            ++n;
        }
        assembly { mstore(out, n) }
        return string(out);
    }

    function name() external view returns (string memory) {
        return symbol();
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    /// Unrestricted on purpose: the harness seeds each real pool with the balance it holds on
    /// mainnet, so the forked pool's own slot0 and liquidity stay consistent with its reserves.
    function mint(address to, uint256 value) external {
        totalSupply += value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(address(0), to, value);
    }

    /**
     * The Base-native surface the worker checks before it will spend.
     *
     * These live on the real token as part of the same precompile, and the values returned here
     * are the ones mainnet returns for every B20 in the catalogue: transfers not paused, the
     * transfer-receiver policy scope, and policy id 5.
     */
    function isPaused(uint8) external pure returns (bool) {
        return false;
    }

    function TRANSFER_RECEIVER_POLICY() external pure returns (bytes32) {
        return 0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363;
    }

    function policyId(bytes32) external pure returns (uint64) {
        return 5;
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}


/**
 * Base's oracle registry, which is also a native precompile.
 *
 * Mainnet answers (1e18, false) for every B20 in the catalogue: a unit multiplier and not
 * paused. Reproduced rather than forked because the real registry reaches into the same
 * precompile surface the tokens do and reverts under revm.
 */
contract OracleRegistryMock {
    function getOracleParams(address) external pure returns (uint256 multiplier, bool paused) {
        return (1e18, false);
    }
}

/** Base's policy registry: another precompile. Authorises the recipient of a B20 transfer. */
contract PolicyRegistryMock {
    function isAuthorized(uint64, address) external pure returns (bool) {
        return true;
    }

    function isPaused(uint8) external pure returns (bool) {
        return false;
    }
}

/**
 * A Chainlink aggregator whose answer is real and whose timestamp is live.
 *
 * The price is the exact value the real feed carried at the forked block, passed in as an
 * immutable. Only `updatedAt` differs: a pinned fork freezes it, and the worker refuses any
 * reference older than 300 seconds — correctly, since a five-minute-old equity price is not a
 * price. Without this the freshness check could never pass on a fork no matter how sound the
 * rest of the system was.
 */
contract FeedMock {
    int256 private immutable _answer;
    uint8 public constant decimals = 8;

    constructor(int256 answer) {
        _answer = answer;
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, _answer, block.timestamp, block.timestamp, 1);
    }
}
