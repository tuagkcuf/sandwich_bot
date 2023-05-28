// setup ethers, required variables, contracts and start function
import { Wallet, ethers } from "ethers"
import { FlashbotsBundleProvider, FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle"
import * as dotenv from "dotenv"

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

const flashbotsUrl = FLASHBOTS_URL
const privateKey = PRIVATE_KEY
const httpProviderUrl = HTTP_PROVIDER_URL
const wsProviderUrl = WS_PROVIDER_URL

const provider = new ethers.provider.JsonRpcProvider(httpProviderUrl)
const wsProvider = new ethers.provider.WebSocketProvider(wsProviderUrl)

// setup contracts and providers
const signingWallet = new Wallet(privateKey).connect(provider)
const uniswapV3Interface = new ethers.utils.Interface(UniswapV3Abi)
const factoryUniswapFactory = new ethers.ContractFactory(
    UniswapFactoryAbi,
    UniswapFactoryBytecode,
    signingWallet
)
const erc20Factory = new ethers.ContractFactory(erc20Abi, erc20Bytecode, signingWallet)
const pairFactory = new ethers.ContractFactory(pairAbi, pairBytecode, signingWallet)
const uniswap = new ethers.ContractFactory(UniswapAbi, UniswapBytecode, signingWallet).attach(
    uniswapV2RouterAddressMainnet
)
let flashbotsProvider = null
let chainId = 1

// setup initial checks
const initialChecks = async (tx) => {
    let transaction = null
    let decoded = null
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
}

// process transaction
const processTransaction = async (tx) => {
    const checksPassed = await initialChecks(tx)
    console.log("checks passed", checksPassed)
}

// create the start function to listen to transactions
const start = async () => {
    flashbotsProvider = await FlashbotsBundleProvider.create(provider, signingWallet, flashbotsUrl)
    console.log(`Listening transactions for the ${chainId} chain id`)
    wsProvider.on("pending", (tx) => {
        processTransaction(tx)
    })
}

start()
