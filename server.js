const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const gameRooms = new Map();
const playerSockets = new Map();

// Game constants
const COLORS = ['red', 'green', 'yellow', 'blue'];
const MAX_PLAYERS = 4;

// Ludo board path positions (52 positions total)
const BOARD_PATH = [
    // Red starting area to Green starting area
    [1,6], [2,6], [3,6], [4,6], [5,6], [6,5], [6,4], [6,3], [6,2], [6,1], [6,0],
    [7,0], [8,0], // Green entry
    [8,1], [8,2], [8,3], [8,4], [8,5], [9,6], [10,6], [11,6], [12,6], [13,6], [14,6],
    [14,7], [14,8], // Yellow entry
    [13,8], [12,8], [11,8], [10,8], [9,8], [8,9], [8,10], [8,11], [8,12], [8,13], [8,14],
    [7,14], [6,14], // Blue entry
    [6,13], [6,12], [6,11], [6,10], [6,9], [5,8], [4,8], [3,8], [2,8], [1,8], [0,8],
    [0,7] // Back to red entry
];

const HOME_PATHS = {
    red: [[1,7], [2,7], [3,7], [4,7], [5,7], [6,7]], // Final 6 positions to center
    green: [[7,1], [7,2], [7,3], [7,4], [7,5], [7,6]],
    yellow: [[13,7], [12,7], [11,7], [10,7], [9,7], [8,7]],
    blue: [[7,13], [7,12], [7,11], [7,10], [7,9], [7,8]]
};

const SAFE_POSITIONS = [0, 8, 13, 21, 26, 34, 39, 47]; // Safe positions on board

class LudoGame {
    constructor(roomCode) {
        this.roomCode = roomCode;
        this.players = [];
        this.currentPlayerIndex = 0;
        this.gameStarted = false;
        this.gameEnded = false;
        this.diceValue = 0;
        this.canRoll = true;
        this.winner = null;
        
        // Token positions for each player (-1 = in home, 0-51 = on board, 52-57 = in final path, 58 = finished)
        this.tokens = {
            red: [-1, -1, -1, -1],
            green: [-1, -1, -1, -1],
            yellow: [-1, -1, -1, -1],
            blue: [-1, -1, -1, -1]
        };
        
        this.consecutiveSixes = 0;
        this.maxConsecutiveSixes = 3;
    }

    addPlayer(socket, playerName) {
        if (this.players.length >= MAX_PLAYERS) {
            return { success: false, message: 'Game is full' };
        }

        if (this.gameStarted) {
            return { success: false, message: 'Game already started' };
        }

        const playerId = socket.id;
        const color = COLORS[this.players.length];
        
        const player = {
            id: playerId,
            name: playerName,
            color: color,
            socket: socket,
            tokensFinished: 0
        };

        this.players.push(player);
        playerSockets.set(playerId, socket);

        return { success: true, player: player };
    }

    removePlayer(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== -1) {
            this.players.splice(playerIndex, 1);
            playerSockets.delete(playerId);
            
            // If current player left, move to next player
            if (playerIndex <= this.currentPlayerIndex && this.currentPlayerIndex > 0) {
                this.currentPlayerIndex--;
            }
            
            // End game if not enough players
            if (this.players.length < 1 && this.gameStarted) {
                this.gameEnded = true;
            }
        }
    }

    startGame() {
        if (this.players.length < 2) {
            return { success: false, message: 'Need at least 2 players to start' };
        }

        this.gameStarted = true;
        this.currentPlayerIndex = 0;
        this.canRoll = true;
        
        return { success: true };
    }

    rollDice(playerId) {
        if (!this.gameStarted || this.gameEnded) {
            return { success: false, message: 'Game not active' };
        }

        const currentPlayer = this.players[this.currentPlayerIndex];
        if (!currentPlayer || currentPlayer.id !== playerId) {
            return { success: false, message: 'Not your turn' };
        }

        if (!this.canRoll) {
            return { success: false, message: 'Cannot roll dice now' };
        }

        this.diceValue = Math.floor(Math.random() * 6) + 1;
        this.canRoll = false;

        // Check for consecutive sixes
        if (this.diceValue === 6) {
            this.consecutiveSixes++;
            if (this.consecutiveSixes >= this.maxConsecutiveSixes) {
                // Skip turn after 3 consecutive sixes
                this.consecutiveSixes = 0;
                this.nextTurn();
                return { 
                    success: true, 
                    diceValue: this.diceValue, 
                    message: 'Three sixes! Turn skipped.',
                    skipTurn: true 
                };
            }
        } else {
            this.consecutiveSixes = 0;
        }

        return { success: true, diceValue: this.diceValue };
    }

    moveToken(playerId, tokenIndex) {
        if (!this.gameStarted || this.gameEnded) {
            return { success: false, message: 'Game not active' };
        }

        const currentPlayer = this.players[this.currentPlayerIndex];
        if (!currentPlayer || currentPlayer.id !== playerId) {
            return { success: false, message: 'Not your turn' };
        }

        if (this.diceValue === 0) {
            return { success: false, message: 'Roll dice first' };
        }

        const color = currentPlayer.color;
        const currentPos = this.tokens[color][tokenIndex];

        // Check if move is valid
        if (!this.isValidMove(color, tokenIndex, this.diceValue)) {
            return { success: false, message: 'Invalid move' };
        }

        // Calculate new position
        const newPos = this.calculateNewPosition(color, tokenIndex, this.diceValue);
        const oldPos = this.tokens[color][tokenIndex];
        
        // Move the token
        this.tokens[color][tokenIndex] = newPos;

        // Check for captures
        const capturedTokens = this.checkCaptures(color, newPos, tokenIndex);

        // Check if token reached finish
        let tokenFinished = false;
        if (newPos === 58) {
            currentPlayer.tokensFinished++;
            tokenFinished = true;
        }

        // Check for win condition
        if (currentPlayer.tokensFinished === 4) {
            this.winner = currentPlayer;
            this.gameEnded = true;
        }

        // Move to next turn (unless rolled 6 and game not ended)
        const rolledSix = this.diceValue === 6;
        if (!rolledSix || this.gameEnded) {
            this.nextTurn();
        } else {
            this.canRoll = true; // Can roll again after six
        }

        this.diceValue = 0; // Reset dice after move

        return {
            success: true,
            oldPos: oldPos,
            newPos: newPos,
            capturedTokens: capturedTokens,
            tokenFinished: tokenFinished,
            extraTurn: rolledSix && !this.gameEnded
        };
    }

    isValidMove(color, tokenIndex, diceValue) {
        const currentPos = this.tokens[color][tokenIndex];

        // Token in home base
        if (currentPos === -1) {
            return diceValue === 6; // Can only come out with 6
        }

        // Token on board or in final path
        const newPos = this.calculateNewPosition(color, tokenIndex, diceValue);
        return newPos <= 58; // Cannot move beyond finish
    }

    calculateNewPosition(color, tokenIndex, diceValue) {
        const currentPos = this.tokens[color][tokenIndex];

        // Token coming out of home
        if (currentPos === -1) {
            const startingPos = this.getStartingPosition(color);
            return startingPos;
        }

        // Token on main board
        if (currentPos < 52) {
            const colorStartPos = this.getStartingPosition(color);
            let newPos = currentPos + diceValue;

            // Check if entering home path
            const homeEntryPos = (colorStartPos + 51) % 52;
            if (currentPos <= homeEntryPos && newPos > homeEntryPos) {
                // Enter home path
                const stepsIntoHome = newPos - homeEntryPos - 1;
                return 52 + stepsIntoHome;
            }

            return newPos % 52;
        }

        // Token in home path (52-57)
        if (currentPos >= 52 && currentPos < 58) {
            return Math.min(currentPos + diceValue, 58);
        }

        return currentPos; // Already finished
    }

    getStartingPosition(color) {
        const positions = { red: 0, green: 13, yellow: 26, blue: 39 };
        return positions[color];
    }

    checkCaptures(movingColor, newPos, movingTokenIndex) {
        if (newPos < 0 || newPos >= 52) return []; // No captures in home or finish area
        if (SAFE_POSITIONS.includes(newPos)) return []; // No captures on safe positions

        const capturedTokens = [];

        // Check all other players' tokens
        for (const player of this.players) {
            if (player.color === movingColor) continue;

            for (let i = 0; i < 4; i++) {
                const tokenPos = this.tokens[player.color][i];
                if (tokenPos === newPos) {
                    // Capture this token
                    this.tokens[player.color][i] = -1; // Send back to home
                    capturedTokens.push({
                        color: player.color,
                        tokenIndex: i,
                        playerId: player.id
                    });
                }
            }
        }

        return capturedTokens;
    }

    nextTurn() {
        if (this.gameEnded) return;
        
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
        this.canRoll = true;
        this.diceValue = 0;
    }

    getGameState() {
        return {
            roomCode: this.roomCode,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                color: p.color,
                tokensFinished: p.tokensFinished
            })),
            currentPlayerIndex: this.currentPlayerIndex,
            currentPlayerId: this.players[this.currentPlayerIndex]?.id,
            gameStarted: this.gameStarted,
            gameEnded: this.gameEnded,
            canRoll: this.canRoll,
            diceValue: this.diceValue,
            tokens: this.tokens,
            winner: this.winner ? {
                id: this.winner.id,
                name: this.winner.name,
                color: this.winner.color
            } : null
        };
    }

    getMovableTokens(color, diceValue) {
        const movableTokens = [];
        
        for (let i = 0; i < 4; i++) {
            if (this.isValidMove(color, i, diceValue)) {
                movableTokens.push(i);
            }
        }
        
        return movableTokens;
    }
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('join-room', (data) => {
        const { playerName, roomCode } = data;
        
        if (!playerName || playerName.trim().length === 0) {
            socket.emit('join-error', { message: 'Please enter a valid name' });
            return;
        }

        let game = gameRooms.get(roomCode);
        
        if (!game) {
            game = new LudoGame(roomCode);
            gameRooms.set(roomCode, game);
        }

        const result = game.addPlayer(socket, playerName.trim());
        
        if (result.success) {
            socket.join(roomCode);
            socket.roomCode = roomCode;
            socket.playerId = socket.id;
            
            socket.emit('join-success', {
                player: result.player,
                gameState: game.getGameState()
            });
            
            // Notify all players in room
            io.to(roomCode).emit('player-joined', {
                player: result.player,
                gameState: game.getGameState()
            });
            
            // Auto start game when 2+ players
            if (game.players.length >= 2 && !game.gameStarted) {
                setTimeout(() => {
                    if (!game.gameStarted) {
                        const startResult = game.startGame();
                        if (startResult.success) {
                            io.to(roomCode).emit('game-started', {
                                gameState: game.getGameState()
                            });
                        }
                    }
                }, 2000); // 2 second delay to let players see who joined
            }
            
        } else {
            socket.emit('join-error', { message: result.message });
        }
    });

    socket.on('roll-dice', () => {
        const roomCode = socket.roomCode;
        const game = gameRooms.get(roomCode);
        
        if (!game) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }

        const result = game.rollDice(socket.id);
        
        if (result.success) {
            const gameState = game.getGameState();
            
            // Get movable tokens for current player
            const currentPlayer = game.players[game.currentPlayerIndex];
            const movableTokens = game.getMovableTokens(currentPlayer.color, result.diceValue);
            
            io.to(roomCode).emit('dice-rolled', {
                playerId: socket.id,
                diceValue: result.diceValue,
                gameState: gameState,
                movableTokens: movableTokens,
                message: result.message,
                skipTurn: result.skipTurn
            });
        } else {
            socket.emit('error', { message: result.message });
        }
    });

    socket.on('move-token', (data) => {
        const { tokenIndex } = data;
        const roomCode = socket.roomCode;
        const game = gameRooms.get(roomCode);
        
        if (!game) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }

        const result = game.moveToken(socket.id, tokenIndex);
        
        if (result.success) {
            io.to(roomCode).emit('token-moved', {
                playerId: socket.id,
                tokenIndex: tokenIndex,
                oldPos: result.oldPos,
                newPos: result.newPos,
                capturedTokens: result.capturedTokens,
                tokenFinished: result.tokenFinished,
                extraTurn: result.extraTurn,
                gameState: game.getGameState()
            });
            
            if (game.gameEnded && game.winner) {
                io.to(roomCode).emit('game-ended', {
                    winner: game.winner,
                    gameState: game.getGameState()
                });
            }
        } else {
            socket.emit('error', { message: result.message });
        }
    });

    socket.on('get-game-state', () => {
        const roomCode = socket.roomCode;
        const game = gameRooms.get(roomCode);
        
        if (game) {
            socket.emit('game-state', { gameState: game.getGameState() });
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        const roomCode = socket.roomCode;
        if (roomCode) {
            const game = gameRooms.get(roomCode);
            if (game) {
                game.removePlayer(socket.id);
                
                // Notify remaining players
                io.to(roomCode).emit('player-left', {
                    playerId: socket.id,
                    gameState: game.getGameState()
                });
                
                // Remove empty rooms
                if (game.players.length === 0) {
                    gameRooms.delete(roomCode);
                    console.log('Room deleted:', roomCode);
                }
            }
        }
    });
});

// API endpoints
app.get('/api/rooms', (req, res) => {
    const rooms = Array.from(gameRooms.entries()).map(([code, game]) => ({
        code: code,
        players: game.players.length,
        maxPlayers: MAX_PLAYERS,
        gameStarted: game.gameStarted,
        gameEnded: game.gameEnded
    }));
    
    res.json(rooms);
});

app.get('/api/room/:code', (req, res) => {
    const game = gameRooms.get(req.params.code);
    if (game) {
        res.json({ exists: true, gameState: game.getGameState() });
    } else {
        res.json({ exists: false });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        rooms: gameRooms.size,
        connections: io.engine.clientsCount 
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Ludo game server running on port ${PORT}`);
    console.log(`Game rooms: ${gameRooms.size}`);
});