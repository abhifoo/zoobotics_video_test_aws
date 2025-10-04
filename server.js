const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store connected bots and operators
const bots = new Map(); // botId -> {socketId, name, status, controller}
const operators = new Map(); // operatorId -> {socketId, name, controllingBot}
const rooms = new Map(); // botId -> Set of viewer socketIds

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Bot registration
  socket.on('register_bot', (data) => {
    const { botId, name } = data;
    bots.set(botId, {
      socketId: socket.id,
      name: name || `Bot-${botId}`,
      status: 'online',
      controller: null
    });
    socket.botId = botId;
    socket.join(`bot_${botId}`);
    
    console.log(`Bot registered: ${botId}`);
    io.emit('bot_list_update', Array.from(bots.entries()).map(([id, info]) => ({
      id,
      name: info.name,
      status: info.status,
      hasController: !!info.controller
    })));
  });

  // Operator registration
  socket.on('register_operator', (data) => {
    const { operatorId, name } = data;
    operators.set(operatorId, {
      socketId: socket.id,
      name: name || `Operator-${operatorId}`,
      controllingBot: null
    });
    socket.operatorId = operatorId;
    
    console.log(`Operator registered: ${operatorId}`);
    socket.emit('bot_list', Array.from(bots.entries()).map(([id, info]) => ({
      id,
      name: info.name,
      status: info.status,
      hasController: !!info.controller
    })));
  });

  // WebRTC signaling: offer from bot
  socket.on('webrtc_offer', (data) => {
    const { targetId, offer, botId } = data;
    console.log(`WebRTC offer from bot ${botId} to ${targetId}`);
    io.to(targetId).emit('webrtc_offer', {
      from: socket.id,
      botId,
      offer
    });
  });

  // WebRTC signaling: answer from operator
  socket.on('webrtc_answer', (data) => {
    const { targetId, answer } = data;
    console.log(`WebRTC answer to ${targetId}`);
    io.to(targetId).emit('webrtc_answer', {
      from: socket.id,
      answer
    });
  });

  // WebRTC signaling: ICE candidates
  socket.on('ice_candidate', (data) => {
    const { targetId, candidate } = data;
    io.to(targetId).emit('ice_candidate', {
      from: socket.id,
      candidate
    });
  });

  // Request control of a bot
  socket.on('request_control', (data) => {
    const { botId } = data;
    const bot = bots.get(botId);
    
    if (!bot) {
      socket.emit('control_denied', { reason: 'Bot not found' });
      return;
    }

    if (bot.controller && bot.controller !== socket.id) {
      socket.emit('control_denied', { reason: 'Bot already controlled' });
      return;
    }

    bot.controller = socket.id;
    socket.controllingBot = botId;
    
    socket.emit('control_granted', { botId });
    io.to(bot.socketId).emit('controller_connected', { 
      controllerId: socket.id 
    });
    
    console.log(`Control granted: ${socket.id} -> ${botId}`);
  });

  // Release control
  socket.on('release_control', (data) => {
    const { botId } = data;
    const bot = bots.get(botId);
    
    if (bot && bot.controller === socket.id) {
      bot.controller = null;
      socket.controllingBot = null;
      
      io.to(bot.socketId).emit('controller_disconnected');
      socket.emit('control_released', { botId });
      
      console.log(`Control released: ${socket.id} from ${botId}`);
    }
  });

  // Motor control commands
  socket.on('motor_command', (data) => {
    const { botId, command } = data;
    const bot = bots.get(botId);
    
    if (!bot) {
      socket.emit('error', { message: 'Bot not found' });
      return;
    }

    // Verify this socket has control
    if (bot.controller !== socket.id) {
      socket.emit('error', { message: 'No control permission' });
      return;
    }

    // Forward command to bot
    io.to(bot.socketId).emit('motor_command', {
      from: socket.id,
      command
    });
  });

  // Join as viewer (for video stream)
  socket.on('join_viewer', (data) => {
    const { botId } = data;
    const bot = bots.get(botId);
    
    if (!bot) {
      socket.emit('error', { message: 'Bot not found' });
      return;
    }

    if (!rooms.has(botId)) {
      rooms.set(botId, new Set());
    }
    rooms.get(botId).add(socket.id);
    
    socket.emit('joined_as_viewer', { botId });
    console.log(`Viewer joined: ${socket.id} -> ${botId}`);
  });

  // Heartbeat/ping
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    // Remove bot
    if (socket.botId) {
      const bot = bots.get(socket.botId);
      if (bot) {
        // Notify controller if any
        if (bot.controller) {
          io.to(bot.controller).emit('bot_disconnected', { 
            botId: socket.botId 
          });
        }
        bots.delete(socket.botId);
      }
      io.emit('bot_list_update', Array.from(bots.entries()).map(([id, info]) => ({
        id,
        name: info.name,
        status: info.status,
        hasController: !!info.controller
      })));
    }
    
    // Remove operator and release control
    if (socket.operatorId) {
      const operator = operators.get(socket.operatorId);
      if (operator && operator.controllingBot) {
        const bot = bots.get(operator.controllingBot);
        if (bot) {
          bot.controller = null;
          io.to(bot.socketId).emit('controller_disconnected');
        }
      }
      operators.delete(socket.operatorId);
    }
    
    // Release control if this socket was controlling
    if (socket.controllingBot) {
      const bot = bots.get(socket.controllingBot);
      if (bot) {
        bot.controller = null;
        io.to(bot.socketId).emit('controller_disconnected');
      }
    }
    
    // Remove from viewer rooms
    rooms.forEach((viewers, botId) => {
      viewers.delete(socket.id);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
