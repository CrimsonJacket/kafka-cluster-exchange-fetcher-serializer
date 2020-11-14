const kafka = require('kafka-node');
const process = require('process');

console.log(`KAFKA_BROKER_LIST: ${process.env.KAFKA_BROKER_LIST}`);

const
  client = new kafka.KafkaClient({ kafkaHost: process.env.KAFKA_BROKER_LIST }),
  producer = new kafka.HighLevelProducer(client);

/**
 * Sends a message containing {@code data} to the specified {@code topic} and then invokes the {@code cb} callback.
 *
 * @param topic: topic to publish the message to.
 * @param data: data to send in the message.
 * @param cb: callback that will be invoked after message has been published.
 *
 * Example usage:
 * {@code sendOne('test', `message ${i} sent`, () => console.log(`Sent message`));}
 */
let sendOne = (topic, data, cb) => {
    const message = {
      id: `${topic}-${Date.now()}`,
      timestamp: Date.now(),
      data: data
    };
    const buffer = new Buffer.from(JSON.stringify(message));
    const record = [{
      topic: topic,
      messages: buffer,
      // attributes: 1 // compress using gzip
    }];
    producer.send(record, cb);

  // console.log(`Published ${JSON.stringify(record)} via kafka`);
  };

module.exports = sendOne;
