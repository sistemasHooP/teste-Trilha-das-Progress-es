const CLASSROOM_CONFIG = {
  totalQuestions: 10,
  questionSeconds: 180,
  maxStudents: 45,
  heartbeatSeconds: 10,
  disconnectSeconds: 30,
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
    }
  ]
};

window.CLASSROOM_CONFIG = CLASSROOM_CONFIG;
