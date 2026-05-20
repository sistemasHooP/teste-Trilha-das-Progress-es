const CLASSROOM_CONFIG = {
  totalQuestions: 10,
  questionSeconds: 180,
  maxStudents: 45,
  heartbeatSeconds: 10,
  disconnectSeconds: 30,
  cleanupFinishedMinutes: 5,
  cleanupIdleLobbyMinutes: 15,
  cleanupRunningMinutes: 60,
  servers: [
    {
      id: 'servidor1',
      label: 'Servidor 1',
      firebaseConfig: {
        apiKey: 'AIzaSyDXE8f6F-oMlL54kk8k6smvZXAwrEMR9OE',
        authDomain: 'trilha-progressao-desafio.firebaseapp.com',
        databaseURL: 'https://trilha-progressao-desafio-default-rtdb.firebaseio.com/',
        projectId: 'trilha-progressao-desafio',
        storageBucket: 'trilha-progressao-desafio.firebasestorage.app',
        messagingSenderId: '184181093538',
        appId: '1:184181093538:web:cc0d0e4c5143a9cb4153fb'
      }
    },
    {
      id: 'servidor2',
      label: 'Servidor 2',
      firebaseConfig: {
        apiKey: 'AIzaSyAbLH7557c2dA2IDVCZ1soKQb4awIO8_QE',
        authDomain: 'trilha-progressao-desafio-2.firebaseapp.com',
        databaseURL: 'https://trilha-progressao-desafio-2-default-rtdb.firebaseio.com',
        projectId: 'trilha-progressao-desafio-2',
        storageBucket: 'trilha-progressao-desafio-2.firebasestorage.app',
        messagingSenderId: '228725969553',
        appId: '1:228725969553:web:66f067221891a4671fa530'
      }
    },
    {
      id: 'servidor3',
      label: 'Servidor 3',
      firebaseConfig: {
        apiKey: 'AIzaSyDdg0xp4qs6j8KahDcDlJWw8crDcHhrGVE',
        authDomain: 'trilha-progressao-desafio-3.firebaseapp.com',
        databaseURL: 'https://trilha-progressao-desafio-3-default-rtdb.firebaseio.com',
        projectId: 'trilha-progressao-desafio-3',
        storageBucket: 'trilha-progressao-desafio-3.firebasestorage.app',
        messagingSenderId: '45817382855',
        appId: '1:45817382855:web:dda45ff520c7b24b0e3be2'
      }
    }
  ]
};

window.CLASSROOM_CONFIG = CLASSROOM_CONFIG;

const MEGA_BATTLE_CONFIG = {
  totalQuestions: 10,
  questionSeconds: 45,
  minTeams: 2,
  maxTeams: 4,
  maxStudentsPerTeam: 60,
  heartbeatSeconds: 10,
  disconnectSeconds: 30,
  cleanupFinishedMinutes: 5,
  cleanupIdleLobbyMinutes: 20,
  cleanupRunningMinutes: 90,
  servers: CLASSROOM_CONFIG.servers
};

window.MEGA_BATTLE_CONFIG = MEGA_BATTLE_CONFIG;
