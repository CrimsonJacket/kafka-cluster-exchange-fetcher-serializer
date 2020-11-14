const kafka = require("kafka-node");

const Consumer = kafka.Consumer;

/**
 * Creates and returns a consumer when passed a kafka topic to subscribe to
 * and a callback that will be invoked when a message is sent to the subscribed topic.
 *
 * @param subscribedTopics: array of topics to subscribe to
 * @param onMessageConsumedCb: callback invoked when message is sent to any of the topics in {@code subscribedTopics}.
 *
 * Example usage:
 * {@code createConsumer(['user.trades.write', 'user.order.write'], (m) => console.log(m));}
 */
let createConsumer = (subscribedTopics, onMessageConsumedCb) => {

  const topics = subscribedTopics.map(sub => {
    return {topic: sub, partition: 0};
  });

  const consumer = new Consumer(
    new kafka.KafkaClient({ kafkaHost: process.env.KAFKA_ADVERTISED_HOST_NAME}),
    topics,
    { encoding: "buffer"}
  );

  consumer.on("error", function(err) {
    console.error(err);
  });

  process.on("SIGINT", function() {
    consumer.close(true, function() {
      process.exit();
    });
  });

  consumer.on("message", function(message) {
    // Read string into a buffer.
    const buf = new Buffer(message.value, "binary");

    const decodedMessage = buf.toString();

    let { id, timestamp, data } = JSON.parse(decodedMessage);

    onMessageConsumedCb({ id: id, sent_time: timestamp, data: data });
  });

  return consumer;
}

module.exports = createConsumer;