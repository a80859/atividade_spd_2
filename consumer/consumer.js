import amqp from 'amqplib';
import Redis from 'ioredis';
import pkg from 'pg';

const { Client } = pkg;

let mqChannel;
let connection;

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

const pgclient = new Client({
  host: 'haproxy',      
  port: 26256,            
  user: 'root',           
  database: 'appdb',  
  ssl: false              
});

async function connectToCockroach() {
  try {
    await pgclient.connect();
    console.log('✅ Connected to CockroachDB via HAProxy');

    const res = await pgclient.query('SELECT now()');
    console.log('🕒 Current time:', res.rows[0]);

  } catch (err) {
    console.error('❌ Connection error:', err.message);
  } 
}

connectToCockroach();

async function setupChannel() {
  try {
    mqChannel = await connection.createChannel();
    
    // Configurar as filas como Quorum
    await mqChannel.assertQueue('add_key', {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-single-active-consumer': false
      }
    });
    
    await mqChannel.assertQueue('del_key', {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-single-active-consumer': false
      }
    });
    
    console.log('✅ Channel setup complete with Quorum queues');
    return mqChannel;
  } catch (err) {
    console.error('❌ Channel setup error:', err.message);
    throw err;
  }
}

async function connectToRabbitWithRetry(maxRetries = 10, delay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      connection = await amqp.connect('amqp://guest:guest@haproxy:5672');
      
      // Configurar handlers de eventos
      connection.on('error', (err) => {
        console.error('🐇 RabbitMQ connection error:', err.message);
        // Forçar reconexão em caso de erro
        setTimeout(() => connectToRabbitWithRetry(), delay);
      });

      connection.on('close', async () => {
        console.warn('🔁 RabbitMQ connection closed. Reconnecting...');
        // Forçar reconexão em caso de fechamento
        setTimeout(() => connectToRabbitWithRetry(), delay);
      });

      // Criar novo canal e configurar filas
      await setupChannel();
      
      // Reconectar consumidores
      await processMessage('add_key', async (msg) => {
        const { key_name, key_value, timestamp } = JSON.parse(msg.content.toString());
        const ts = new Date(timestamp);

        if (!key_name || !key_value || !timestamp) {
          console.warn(`⚠️ Invalid add_key message: ${msg.content.toString()}`);
          mqChannel.nack(msg, false, false);
          return;
        }

        const upt_result = await pgclient.query(
          `INSERT INTO kv_store (key, value, last_updated)
           VALUES ($1, $2, $3)
           ON CONFLICT (key)
           DO UPDATE SET value = $2, last_updated = $3
           WHERE kv_store.last_updated <= $3`,
          [key_name, key_value, ts]
        );

        console.log('📝 Rows:', upt_result.rows); 

        if (upt_result.rowCount > 0) { 
          try {
            const redisVal = await redis.get(key_name);
            if (redisVal !== null) {
              await redis.set(key_name, key_value);
            }
          } catch (err) {
            console.error(`❌ Error: ${err.message}`);
          }
        }

        console.log(`✅ [add_key] ${key_name} set to "${key_value}" at ${timestamp}`);
        mqChannel.ack(msg);
      });

      await processMessage('del_key', async (msg) => {
        const { key_name, timestamp } = JSON.parse(msg.content.toString());
        const ts = new Date(timestamp);

        if (!key_name || !timestamp) {
          console.warn(`⚠️ Invalid del_key message: ${msg.content.toString()}`);
          mqChannel.nack(msg, false, false);
          return;
        }

        const res = await pgclient.query(
          'SELECT last_updated FROM kv_store WHERE key = $1',
          [key_name]
        );

        if (res.rows.length === 0) {
          const retries = msg.properties.headers['x-retry'] || 0;

          if (retries < 3) {
            console.warn(`⏳ [del_key] Key "${key_name}" not found. Retrying... (attempt ${retries + 1})`);
            mqChannel.nack(msg, false, false); 

            await mqChannel.sendToQueue('del_key', Buffer.from(msg.content.toString()), {
              headers: { 'x-retry': retries + 1 },
              expiration: 3000, 
            });

            return;
          } else {
            console.warn(`❌ [del_key] Key "${key_name}" not found after ${retries} retries. Dropping.`);
            mqChannel.ack(msg);
            return;
          }
        }

        const dbTimestamp = new Date(res.rows[0].last_updated);

        if (dbTimestamp <= ts) {
          await pgclient.query('DELETE FROM kv_store WHERE key = $1', [key_name]);
          console.log(`✅ [del_key] Deleted "${key_name}" at ${timestamp}`);
          try {
            const redisVal = await redis.get(key_name);
            if (redisVal !== null) {
              await redis.del(key_name);
            }
          } catch (err) {
            console.error(`❌ Error: ${err.message}`);
          }
        } else {
          console.log(`⏩ [del_key] Skipped deletion of "${key_name}" — newer value exists.`);
        }

        mqChannel.ack(msg);
      });

      console.log('✅ Connected to RabbitMQ via HAProxy');
      return;
    } catch (err) {
      console.warn(`RabbitMQ not ready (attempt ${attempt}/${maxRetries}): ${err.message}`);
      if (attempt === maxRetries) throw new Error('❌ Could not connect to RabbitMQ');
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Função para reconectar o canal se necessário
async function ensureChannel() {
  if (!mqChannel) {
    await setupChannel();
  }
  return mqChannel;
}

// Iniciar conexão
await connectToRabbitWithRetry();

console.log('📬 Listening to add_key queue...');

// Função para processar mensagens com retry
async function processMessage(queue, handler) {
  const channel = await ensureChannel();
  await channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      await handler(msg);
    } catch (err) {
      console.error(`❌ Error processing message: ${err.message}`);
      channel.nack(msg, false, false);
    }
  });
}


