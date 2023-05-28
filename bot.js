// 1. Setup ethers, required variables, contracts and start function
import { Wallet, ethers } from "ethers"
import {
    FlashbotsBundleProvider,
    FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle"
import * as dotenv from "dotenv"

// 1.1. Setup ABIs and Bytecodes
import {
    UniswapAbi,
    UniswapBytecode,
    UniswapFactoryAbi,
    UniswapFactoryBytecode,
    pairAbi,
    pairBytecode,
    erc20Abi,
    erc20Bytecode,
    UniswapV3Abi,
    wethAddressMainnet,
    uniswapV2RouterAddressMainnet,
    uniswapFactoryAddressMainnet,
    universalRouterAddressMainnet,
} from "./notes"

dotenv.config()

// 1.2. Setup variables
const flashbotsUrl = FLASHBOTS_URL
const privateKey = PRIVATE_KEY
const httpProviderUrl = HTTP_PROVIDER_URL
const wsProviderUrl = WS_PROVIDER_URL
const bribeToMiners = ethers.utils.parseUnits("20", "gwei")
const buyAmount = ethers.utils.parseUnits("0.1", "ether")

const provider = new ethers.providers.JsonRpcProvider(httpProviderUrl)
const wsProvider = new ethers.providers.WebSocketProvider(wsProviderUrl)

// 1.3. Setup contracts and providers
const signingWallet = new Wallet(privateKey).connect(provider)
const uniswapV3Interface = new ethers.utils.Interface(UniswapV3Abi)
const factoryUniswapFactory = new ethers.ContractFactory(
    UniswapFactoryAbi,
    UniswapFactoryBytecode,
    signingWallet
).attach(uniswapFactoryAddressMainnet)
const erc20Factory = new ethers.ContractFactory(erc20Abi, erc20Bytecode, signingWallet)
const pairFactory = new ethers.ContractFactory(pairAbi, pairBytecode, signingWallet)
const uniswap = new ethers.ContractFactory(UniswapAbi, UniswapBytecode, signingWallet).attach(
    uniswapV2RouterAddressMainnet
)
let flashbotsProvider = null
let chainId = 1

// 2. Create the start function to listen to transactions
// 2.5. Decode uniswap universal router transactions
const decodeUniversalRouterSwap = (input) => {
    const abiCoder = new ethers.utils.AbiCoder()
    const decodedParameters = abiCoder.decode(
        ["address", "uint256", "uint256", "bytes", "bool"],
        input
    )
    const breakdown = input.substring(2).match(/.{1,64}/g)

    let path = []
    let hasTwoPath = true
    if (breakdown.length != 9) {
        const pathOne = "0x" + breakdown[breakdown.length - 2].substring(24)
        const pathTwo = "0x" + breakdown[breakdown.length - 1].substring(24)
        path = [pathOne, pathTwo]
    } else {
        hasTwoPath = false
    }

    return {
        recipient: parseInt(decodedParameters[(0, 16)]),
        amountIn: decodedParameters[1],
        minAmountOut: decodedParameters[2],
        path,
        hasTwoPath,
    }
}

// 3. Setup initial checks
const initialChecks = async (tx) => {
    let transaction = null
    let decoded = null
    let decodedSwap = null

    try {
        transaction = await provider.getTransaction(tx)
    } catch (e) {
        return false
    }

    if (!transaction || !transaction.to) {
        return false
    }

    if (Number(transaction.value) == 0) return false

    if (transaction.to.toLowerCase() != universalRouterAddressMainnet.toLowerCase()) {
        return false
    }

    try {
        decoded = uniswapV3Interface.parseTransaction(transaction)
    } catch (e) {
        return false
    }

    // if the swap is not for uniswapv2 we return it
    if (!decoded.args.commands.includes("08")) return false
    let swapPositionInCommands = decoded.args.commands.substring(2).indexOf("08") / 2
    let inputPosition = decoded.args.inputs[swapPositionInCommands]
    decodedSwap = decodeUniversalRouterSwap(inputPosition)
    if (!decodedSwap.hasTwoPath) return false
    if (decodedSwap.recipient === 2) return false
    if (decodedSwap.path[0].toLowerCase() != wethAddressMainnet.toLowerCase()) return false

    return {
        transaction,
        amountIn: transaction.value, // victim's ether
        minAmountOut: decodedSwap.minAmountOut,
        tokenToCapture: decodedSwap.path[1],
    }
}

// 4. Process transaction
const processTransaction = async (tx) => {
    const checksPassed = await initialChecks(tx)
    if (!checksPassed) return false
    const { transaction, amountIn, minAmountOut, tokenToCapture } = checksPassed

    // 5. Get and sort the reserves
    const pairAddress = await factoryUniswapFactory.getPair(wethAddressMainnet, tokenToCapture)
    const pair = pairFactory.attach(pairAddress)

    let reserves = null
    try {
        reserves = await pair.getReserves()
    } catch (e) {
        return false
    }

    let a
    let b
    if (wethAddressMainnet < tokenToCapture) {
        a = reserves._reserve0
        b = reserves._reserve1
    } else {
        a = reserves._reserve1
        b = reserves._reserve0
    }

    // 6. Get fee costs for simplicity we'll add the user's gas fee
    const maxGasFee = transaction.maxFeePerGas
        ? transaction.maxFeePerGas.add(bribeToMiners)
        : bribeToMiners
    const priorityFee = transaction.maxPriorityFeePerGas.add(bribeToMiners)

    // 7. Buy using your amount in and calculate amount out
    let firstAmountOut = await uniswap.getAmountOut(buyAmount, a, b)
    const updatedReserveA = a.add(buyAmount)
    const updateReserveB = b.add(firstAmountOut)
    let secondBuyAmount = await uniswap.getAmountOut(amountIn, updatedReserveA, updateReserveB)
    if (secondBuyAmount.lt(minAmountOut))
        return console.log("Victim would get less than the minimum")
    const updatedReserveA2 = a.add(amountIn)
    const updatedReserveB2 = b.add(secondBuyAmount)
    // How much ETH we get at the end with a potential profit
    let thirdAmountOut = await uniswap.getAmountOut(
        firstAmountOut,
        updatedReserveB2,
        updatedReserveA2
    )

    // 8. Prepare first transaction
    const deadline = Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour from now
    let firstTransaction = {
        signer: signingWallet,
        transaction: await uniswap.populateTransaction.swapExactETHForTokens(
            firstAmountOut,
            [wethAddressMainnet, tokenToCapture],
            signingWallet.address,
            deadline,
            {
                value: buyAmount,
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    }
    firstTransaction.transaction = {
        ...firstTransaction.transaction,
        chainId,
    }

    // 9. Prepare second transaction
    const victimsTransactionWithChainId = {
        chainId,
        ...transaction,
    }
    const signedMiddleTransaction = {
        signedTransaction: ethers.utils.serializeTransaction(victimsTransactionWithChainId, {
            r: victimsTransactionWithChainId.r,
            s: victimsTransactionWithChainId.s,
            v: victimsTransactionWithChainId.v,
        }),
    }

    // 10. Prepare third transaction for the approval
    const erc20 = erc20Factory.attach(tokenToCapture)
    let thirdTransaction = {
        signer: signingWallet,
        transaction: await erc20.populateTransaction.approve(
            uniswapV2RouterAddressMainnet,
            firstAmountOut,
            {
                value: "0",
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    }
    thirdTransaction.transaction = {
        ...thirdTransaction.transaction,
        chainId,
    }

    // 11. Prepare the last transaction to get the final eth
    let fourthTransaction = {
        signer: signingWallet,
        transaction: await uniswap.populateTransaction.swapExactETHForTokens(
            firstAmountOut,
            thirdAmountOut,
            [tokenToCapture, wethAddressMainnet],
            signingWallet.address,
            deadline,
            {
                value: "0",
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    }
    fourthTransaction.transaction = {
        ...fourthTransaction.transaction,
        chainId,
    }

    const transactionsArray = [
        firstTransaction,
        signedMiddleTransaction,
        thirdTransaction,
        fourthTransaction,
    ]
    const signedTransactions = await flashbotsProvider.signBundle(transactionsArray)
    const blockNumber = await provider.getBlockNumber()

    console.log("Simulating...")
    const simulation = await flashbotsProvider.simulate(signedTransactions, blockNumber + 1)
    if (simulation.firstRevert) {
        return console.log("Simulation error", simulation.firstRevert)
    }

    // 12. Send transactions with flashbots
    let bundleSubmission
    flashbotsProvider
        .sendRawBundle(signedTransactions, blockNumber + 1)
        .then((_bundleSubmission) => {
            bundleSubmission = _bundleSubmission
            console.log("Bundle submitted", bundleSubmission.bundleHash)
            return bundleSubmission.wait()
        })
        .then(async (waitResponse) => {
            console.log("Wait response", FlashbotsBundleResolution[waitResponse])
            if (waitResponse == FlashbotsBundleResolution.BundleIncluded) {
                console.log("----------------------------")
                console.log("----------------------------")
                console.log("---------Bundle Included----")
                console.log("----------------------------")
                console.log("----------------------------")
            } else if (waitResponse == FlashbotsBundleResolution.AccountNonceTooHigh) {
                console.log("The transaction has been already confirmed")
            } else {
                console.log("Bundle hash", bundleSubmission.bundleHash)
                try {
                    console.log({
                        bundleStats: await flashbotsProvider.getBundleStats(
                            bundleSubmission.bundleHash,
                            blockNumber + 1
                        ),
                        userStats: await flashbotsProvider.getUserStats(),
                    })
                } catch (e) {
                    return false
                }
            }
        })
}

const start = async () => {
    flashbotsProvider = await FlashbotsBundleProvider.create(provider, signingWallet, flashbotsUrl)
    console.log(`Listening transactions for the ${chainId} chain id`)
    wsProvider.on("pending", (tx) => {
        processTransaction(tx)
    })
}

start()

// Next steps:
// - calculate gas costs
// - estimate the next base fee
// - calculate amounts out locally
// - use multiple block builders besides flashbots
// - reduce gas costs by using an assembly yul contract
// - use multiple cores from your computer to improve performance
// - calculate the transaction array for type 0 and type 2 transactions
// - implement multiple dexes like uniswap, shibaswap, sushiswap, and others
// - calculate the pair address locally with a function without a blockchain request
// - calculate the exact amount you'll get in profit after the first, middle and last trade without request and without loops
