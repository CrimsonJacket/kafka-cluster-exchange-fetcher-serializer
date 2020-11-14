const axios = require("axios");
const WebSocket = require("ws");
const Producer = require("./kafkaProducerService");

const WS_URL = `wss://stream.binance.com:9443/ws`;
const BACKEND_API_URL = "http://localhost:8080/api";
const BINANCE__BASE_API_URL = "https://api.binance.com/api";

const Queue = require('./utils/queue');

const SUPPORTED_BINANCE_MARKETS = [
  "BNBUSDT",
  "BTCUSDT",
  "ETHUSDT",
  "XRPUSDT",
  "BCHUSDT",
  "LTCUSDT",
]

const ZERO_DECIMAL = parseFloat("0");

class ExchangeFetcher {

  constructor(exchangeName, env="dev") {
    this.exchangeName = exchangeName;
    this.env = env;

    this.httpClient = axios.create({
      baseURL: BACKEND_API_URL
    })

    this.exchangeAPIClient = axios.create({
      baseURL: BINANCE__BASE_API_URL
    })

    this.websocketClient = null;

    this.kafkaMessageQueue = [];

    this.marketInfoList = new Array();
    this.marketIdMap = {}
    this.isWaitingForMarketSnapshot = new Map();
    this.marketWebSocketMessageQueue = new Queue();

    this.orderBookMapping = new Map();
    /**
     * i.e. TradingPair-OrderBook Mapping
     * {
     *  BNBUSDT: {
     *    marketId: 1,
     *    lastUpdateId: 124,
     *    bids: {
     *      1.00: 100,
     *      1.01: 101,
     *    },
     *    asks: {
     *      2.00: 200,
     *      2.01: 201,
     *    }
     *  },
     *  BTCUSDT: {
     *    ...
     *  }
     * }
     */
  }

  /**
   * Fetch Market Information from Backend API server.
   * Ensures that fetcher is fetching only active markets
   */
  async getMarketInfo() {
    return this.httpClient.get('/markets')
      .then(res => {
        const data = res.data;
        return data.filter(info => 
          SUPPORTED_BINANCE_MARKETS.includes(info.tradingPair)
        );
      }).catch(err => {
        console.log(`Error fetching exchange info: ${err.message}`);
        throw err;
      });
  }

  // Subscribes to the list of markets
  handleSocketOpen = function (request) {
    this.isAlive = true;
    console.log("WebSocket Connection Request: " + JSON.stringify(request))
    this.send(JSON.stringify(request))
  }

  handleSocketError = function (error) {
    console.log("WebSocket Error: " + this.endpoint +
    ( error.code ? ' (' + error.code + ')' : '' ) +
    ( error.message ? ' ' + error.message : '' ) );
  }

  handleSocketClose = function (error) {
    console.log(error)
    console.log("WebSocket closed.")
  }

  /**
   * Fetches Market Snapshot from Exchange API.
   * Initialiazes the OrderBook mapping.
   */
  async retrieveMarketSnapshot() {
    await new Promise(r => setTimeout(r, 1000));  // Waits for some websocket messages to be queued
    await Promise.all(this.marketInfoList.map(async (market) => {
      let params = {
        params: {
          symbol: market.tradingPair,
          limit: 1000
        }
      }
      const data = await this.exchangeAPIClient.get('/v3/depth', params)
        .then(res => {
          return res.data
        })
        .catch(err => {
          console.log(`Error occured retrieving ${market.tradingPair} snapshot, err: ${err}`)
        });

      const lastUpdateId = data.lastUpdateId;
      const bids = data.bids;
      const asks = data.asks;

      let ob = new Map();
      let bidsPriceQtyMap = new Map();
      let asksPriceQtyMap = new Map();

      bids.forEach(bid => {
        bidsPriceQtyMap.set(bid[0], bid[1])
      })

      asks.forEach(ask => {
        asksPriceQtyMap.set(ask[0], ask[1])
      })

      ob.set("lastUpdateId", lastUpdateId);
      ob.set("bids", bidsPriceQtyMap);
      ob.set("asks", asksPriceQtyMap);
      
      this.orderBookMapping.set(market.tradingPair, ob)

    }));
  }

  /**
   * Main loop processing websocket messages.
   */
  async processWebSocketMessages() {
    while(true){
      let msg = await this.marketWebSocketMessageQueue.dequeue();

      if (msg["id"] != null) continue;

      const market = msg["s"];
      const marketId = this.marketIdMap[market];

      let ob = this.orderBookMapping.get(market);
      let lastUpdateId = ob.get("lastUpdateId");

      if (msg["u"] <= lastUpdateId) continue;
      if (msg["U"] <= lastUpdateId+1 && msg["u"] >= lastUpdateId+1) {
        let obBids = ob.get("bids");
        let obAsks = ob.get("asks");

        let msgBids = msg["b"];
        let msgAsks = msg["a"];

        msgBids.forEach(bid => {
          if (parseFloat(bid[1]) == ZERO_DECIMAL){
            obBids.delete(bid[0])
            return;
          }
          obBids.set(bid[0], bid[1])
        })

        msgAsks.forEach(ask => {
          if (parseFloat(ask[1]) == ZERO_DECIMAL){
            obAsks.delete(ask[0])
            return;
          }
          obAsks.set(ask[0], ask[1])
        })
        
        ob.set("bids", obBids);
        ob.set("asks", obAsks);
        ob.set("lastUpdateId", msg["u"]);
        // console.log(`${market} | lastUpdateId: ${msg["u"]}`);
        this.orderBookMapping.set(market, ob);

        let bestBid = Math.max(...Array.from(obBids.keys()).map(bid => parseFloat(bid)));
        let bestAsk = Math.min(...Array.from(obAsks.keys()).map(ask => parseFloat(ask)));


        const message = {
          market: market,
          marketId: marketId,
          midPrice: ((bestBid+bestAsk)/2).toPrecision(8),
          timestamp: msg["E"],
        };
                
        try {
          Producer("midprice.update", JSON.stringify(message), () => {
          console.log(`Published Midprice Update [${message.timestamp}] ${message.market} | ${message.midPrice}`)
          });
        } catch (err) {
          console.log(`Error posting to user.order.write ${err.message}`);
        }
      }
    }
  }
  /**
   * Starts the fetcher. Startup process is as follows:
   * 1. Fetch all Market Details, given an exchange, from Database.
   * 2. Initialize Market OrderBooks 
   *    (i)   For each market, start a websocket connection and begin listening for market deltas.
   *    (ii)  For each market, fetch an OrderBook snapshot.
   *    (iii) Initialize market's orderbook with the snapshot
   * 3. Apply market deltas to respective orderbooks that comes after snapshot timestamp. 
   *    (i)   Also sends a kafka message to the `exchange.orderbook.write` topic.
   */
  async start(){

    this.marketInfoList = [
      {
        marketId: 1,
        tradingPair: "BTCUSDT",
      },
    ]

    this.marketInfoList.forEach(market => {
      this.orderBookMapping.set(
        market["tradingPair"], 
        {
            marketId: market["marketId"],
            lastUpdateId: -1,
            bids: new Map(),
            asks: new Map()
        });
      this.marketIdMap[market["tradingPair"]] = market["marketId"];
    })
      
    // Parse Params
    var params = []
    this.marketInfoList.forEach(market => {
      params.push(`${market["tradingPair"].toLowerCase()}@depth@1000ms`)
    });

    // Create WebSocket subscription request
    let subscriptionRequest = {
      "method": "SUBSCRIBE",
      "params": params,
      "id": 1
    }

    // Establish Websocket connection
    let ws = new WebSocket(WS_URL);
    ws.isAlive = false;

    ws.on('open', this.handleSocketOpen.bind(ws, subscriptionRequest));
    ws.on('error', this.handleSocketError.bind(ws));
    ws.on('close', this.handleSocketClose.bind(ws));

    /**
     * When new message comes through ws, push into message queue to be processed.
     * Processing will occur after snapshot is fetched from API
     */
    ws.on('message', data => {
      try {
        let parsed_data = JSON.parse(data);
        this.marketWebSocketMessageQueue.enqueue(parsed_data);
      } catch (error) {
        console.log(this.exchangeName + " fetcher failed to parse market deltas. " + error);
      }
    });

    /**
     * Fetch snapshot from API
     * Process messages in message queue for the corr market by applying filtering logic
     */
    await this.retrieveMarketSnapshot()
      .then(() => {
        this.processWebSocketMessages();
      });
    
  };

  
  stop() {
    if (this.websocketClient != null){
      try {
        this.websocketClient.close()
        this.websocketClient = null
      } catch (error) {
        console.log("Error closing websocket client.")
      }
    }
  };
}

const fetcher = new ExchangeFetcher("binance")

fetcher.start();
