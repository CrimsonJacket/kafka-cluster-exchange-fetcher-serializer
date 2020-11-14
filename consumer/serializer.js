const Consumer = require('./kafkaConsumerService');

const midpriceWriteCb = async (msg) => {
  try {
    const data = JSON.parse(msg.data)

    const midprice = {
      marketId: data.marketId,
      midprice: data.midPrice,
      timestamp: data.timestamp,
    }
    console.log(`Received Midprice Update: ${JSON.stringify(midprice)}`);
    return;
  } catch (e) {
    console.log(e.message);
  }

};

Consumer(['midprice.update'], midpriceWriteCb);