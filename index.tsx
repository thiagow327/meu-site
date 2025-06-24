import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';

// Define the Firebase configuration and app ID, which are provided by the environment.
// If not available, default values are used for local development/testing.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-hospital-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Urgency levels with their names, Tailwind CSS colors, and priority levels.
// Lower 'level' value means higher urgency (e.g., Vermelho is 1, Azul is 5).
const urgencyLevels = [
    { name: 'Vermelho', color: 'bg-red-500', text: 'text-red-900', level: 1, description: 'Emergência (risco de morte iminente)' },
    { name: 'Laranja', color: 'bg-orange-500', text: 'text-orange-900', level: 2, description: 'Muito Urgente (risco significativo)' },
    { name: 'Amarelo', color: 'bg-yellow-500', text: 'text-yellow-900', level: 3, description: 'Urgente (condição séria)' },
    { name: 'Verde', color: 'bg-green-500', text: 'text-green-900', level: 4, description: 'Pouco Urgente (baixa complexidade)' },
    { name: 'Azul', color: 'bg-blue-500', text: 'text-blue-900', level: 5, description: 'Não Urgente (casos eletivos)' },
];

/**
 * Main application component for the Hospital Password Manager.
 * Manages patient queues, urgency categorization, and real-time updates with Firebase.
 */
export default function App() {
    // State variables for Firebase services and user information.
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false); // Flag to ensure auth is ready before Firestore ops

    // State variables for patient data and UI elements.
    const [patients, setPatients] = useState([]); // List of patients in the queue
    const [currentServing, setCurrentServing] = useState(null); // Patient currently being served
    const [newPatientName, setNewPatientName] = useState(''); // Input for new patient name
    const [newPatientUrgency, setNewPatientUrgency] = useState(urgencyLevels[3].name); // Default to 'Verde'
    const [passwordCounter, setPasswordCounter] = useState({}); // Stores next available password number per urgency type
    const [message, setMessage] = useState({ text: '', type: '' }); // For displaying messages (success/error)
    const [showConfirmModal, setShowConfirmModal] = useState(false); // State for confirmation modal
    const confirmActionRef = useRef(null); // Ref to store the function to be executed on confirmation

    // ---------------------------------------------------
    // Firebase Initialization and Authentication
    // ---------------------------------------------------
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const firebaseAuth = getAuth(app);

            setDb(firestore);
            setAuth(firebaseAuth);

            // Listen for authentication state changes
            const unsubscribeAuth = onAuthStateChanged(firebaseAuth, async (user) => {
                if (user) {
                    setUserId(user.uid);
                    console.log('Firebase authenticated. User ID:', user.uid);
                } else {
                    // Sign in anonymously if no user is present
                    console.log('No user, signing in anonymously...');
                    await signInAnonymously(firebaseAuth);
                    setUserId(firebaseAuth.currentUser?.uid || crypto.randomUUID());
                }
                setIsAuthReady(true); // Set auth ready flag
            });

            // If an initial custom auth token is provided, sign in with it.
            // This is typically for Canvas environment.
            if (initialAuthToken) {
                console.log('Signing in with custom token...');
                signInWithCustomToken(firebaseAuth, initialAuthToken)
                    .then(() => console.log('Signed in with custom token'))
                    .catch(error => console.error('Error signing in with custom token:', error));
            }

            return () => {
                unsubscribeAuth(); // Clean up auth listener on component unmount
            };
        } catch (error) {
            console.error("Erro ao inicializar Firebase:", error);
            setMessage({ text: 'Erro ao inicializar o Firebase. Verifique a configuração.', type: 'error' });
        }
    }, [initialAuthToken, firebaseConfig]);

    // ---------------------------------------------------
    // Real-time Patient Data Listener (Firestore)
    // ---------------------------------------------------
    useEffect(() => {
        if (!db || !auth || !isAuthReady || !userId) {
            console.log('Firebase not ready for data fetching.');
            return;
        }

        const patientsCollectionRef = collection(db, `artifacts/${appId}/public/data/patients`);
        // Modified query: Removed orderBy to avoid index requirement. Data will be sorted client-side.
        const q = query(patientsCollectionRef);

        const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
            const fetchedPatients = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            // Client-side sorting: first by urgency level, then by timestamp (earliest first).
            const sortedFetchedPatients = [...fetchedPatients].sort((a, b) => {
                if (a.urgencyLevel !== b.urgencyLevel) {
                    return a.urgencyLevel - b.urgencyLevel;
                }
                // Ensure timestamp exists before comparing toMillis
                const timestampA = a.timestamp ? a.timestamp.toMillis() : 0;
                const timestampB = b.timestamp ? b.timestamp.toMillis() : 0;
                return timestampA - timestampB;
            });

            // Filter out patients currently being served from the main queue display
            const queuePatients = sortedFetchedPatients.filter(p => !p.isServing);
            setPatients(queuePatients);

            // Find the patient currently being served
            const servingPatient = fetchedPatients.find(p => p.isServing); // Search in unsorted fetchedPatients for the serving one
            setCurrentServing(servingPatient || null);

            // Update password counters for next generation
            const counters = {};
            urgencyLevels.forEach(level => {
                const prefix = level.name.substring(0, 1).toUpperCase();
                const lastNum = fetchedPatients // Use unsorted fetchedPatients for accurate counter based on all existing patients
                    .filter(p => p.urgency === level.name)
                    .reduce((max, p) => {
                        const num = parseInt(p.password.split('-')[1]);
                        return isNaN(num) ? max : Math.max(max, num);
                    }, 0);
                counters[prefix] = lastNum + 1;
            });
            setPasswordCounter(counters);

            console.log("Dados de pacientes atualizados.");
        }, (error) => {
            console.error("Erro ao carregar dados de pacientes:", error);
            setMessage({ text: 'Erro ao carregar pacientes do Firestore.', type: 'error' });
        });

        // Clean up snapshot listener on component unmount
        return () => unsubscribeSnapshot();
    }, [db, auth, isAuthReady, userId]); // Re-run if db, auth, or authReady state changes

    // ---------------------------------------------------
    // Helper Functions
    // ---------------------------------------------------

    /**
     * Shows a temporary message to the user.
     * @param {string} text - The message text.
     * @param {string} type - 'success' or 'error' for styling.
     */
    const showMessage = (text, type) => {
        setMessage({ text, type });
        setTimeout(() => setMessage({ text: '', type: '' }), 3000); // Clear message after 3 seconds
    };

    /**
     * Displays a confirmation modal before performing a critical action.
     * @param {function} actionFunction - The function to call if confirmed.
     * @param {string} messageText - The message to display in the modal.
     */
    const showConfirmation = (actionFunction, messageText) => {
        confirmActionRef.current = actionFunction;
        setMessage({ text: messageText, type: 'confirm' }); // Use 'confirm' type for modal
        setShowConfirmModal(true);
    };

    /**
     * Handles confirmation from the modal.
     */
    const handleConfirm = () => {
        if (confirmActionRef.current) {
            confirmActionRef.current();
        }
        setShowConfirmModal(false);
        setMessage({ text: '', type: '' });
    };

    /**
     * Handles cancellation from the modal.
     */
    const handleCancel = () => {
        setShowConfirmModal(false);
        setMessage({ text: '', type: '' });
    };

    // ---------------------------------------------------
    // CRUD Operations (Firestore)
    // ---------------------------------------------------

    /**
     * Adds a new patient to the Firestore collection.
     */
    const addPatient = async () => {
        if (!db || !userId) {
            showMessage('Erro: Firebase não está pronto.', 'error');
            return;
        }

        const selectedUrgency = urgencyLevels.find(level => level.name === newPatientUrgency);
        if (!selectedUrgency) {
            showMessage('Por favor, selecione uma categoria de urgência válida.', 'error');
            return;
        }

        const prefix = newPatientUrgency.substring(0, 1).toUpperCase();
        // Ensure passwordCounter has been initialized before attempting to access prefix
        const nextNumber = (passwordCounter[prefix] !== undefined ? passwordCounter[prefix] : 1); // Default to 1 if no previous count
        const password = `${prefix}-${String(nextNumber).padStart(3, '0')}`;

        try {
            await addDoc(collection(db, `artifacts/${appId}/public/data/patients`), {
                name: newPatientName || 'Paciente sem nome',
                urgency: newPatientUrgency,
                urgencyLevel: selectedUrgency.level, // Store numeric level for easy sorting
                password: password,
                timestamp: serverTimestamp(), // Use server timestamp for reliable ordering
                isServing: false, // Flag to indicate if patient is currently being served
            });
            setNewPatientName('');
            showMessage(`Senha ${password} adicionada com sucesso!`, 'success');
        } catch (error) {
            console.error("Erro ao adicionar paciente:", error);
            showMessage('Erro ao adicionar paciente. Tente novamente.', 'error');
        }
    };

    /**
     * Calls the next patient in the queue based on urgency and timestamp.
     * This moves the patient from the queue to 'currentServing'.
     */
    const callNextPatient = async () => {
        if (!db || !userId) {
            showMessage('Erro: Firebase não está pronto.', 'error');
            return;
        }

        // If there's a patient currently being served, ask for confirmation to finish.
        if (currentServing) {
            showConfirmation(() => actuallyCallNextPatient(), 'Já existe um paciente sendo atendido. Deseja finalizar o atendimento atual e chamar o próximo?');
        } else {
            actuallyCallNextPatient();
        }
    };

    const actuallyCallNextPatient = async () => {
        // Clear current serving if any, to allow new patient to be called
        if (currentServing) {
            try {
                await updateDoc(doc(db, `artifacts/${appId}/public/data/patients`, currentServing.id), {
                    isServing: false, // Mark as no longer serving
                    // Optionally, you could delete the document here if you don't need a history
                });
                console.log(`Paciente ${currentServing.password} finalizado.`);
            } catch (error) {
                console.error("Erro ao finalizar paciente atual:", error);
                showMessage('Erro ao finalizar paciente atual.', 'error');
                return; // Stop if finishing fails
            }
        }

        // Sort patients to find the next one:
        // 1. By urgency level (lowest first - higher priority)
        // 2. By timestamp (earliest first - FIFO within same urgency)
        const sortedPatients = [...patients].sort((a, b) => {
            if (a.urgencyLevel !== b.urgencyLevel) {
                return a.urgencyLevel - b.urgencyLevel;
            }
            // Ensure timestamp exists before comparing toMillis
            const timestampA = a.timestamp ? a.timestamp.toMillis() : 0;
            const timestampB = b.timestamp ? b.timestamp.toMillis() : 0;
            return timestampA - timestampB; // Compare timestamps
        });

        const nextPatient = sortedPatients[0];

        if (nextPatient) {
            try {
                await updateDoc(doc(db, `artifacts/${appId}/public/data/patients`, nextPatient.id), {
                    isServing: true,
                });
                showMessage(`Chamando senha: ${nextPatient.password} (${nextPatient.urgency})`, 'success');
            } catch (error) {
                console.error("Erro ao chamar próximo paciente:", error);
                showMessage('Erro ao chamar o próximo paciente. Tente novamente.', 'error');
            }
        } else {
            showMessage('Não há pacientes na fila para chamar.', 'info');
        }
    };

    /**
     * Marks the currently serving patient as finished (removes them from the display).
     * Optionally, could delete the document from Firestore or move to a 'history' collection.
     */
    const finishServing = async () => {
        if (!db || !userId || !currentServing) {
            showMessage('Nenhum paciente sendo atendido para finalizar.', 'info');
            return;
        }

        showConfirmation(async () => {
            try {
                // Delete the document from Firestore after serving
                await deleteDoc(doc(db, `artifacts/${appId}/public/data/patients`, currentServing.id));
                showMessage(`Atendimento da senha ${currentServing.password} finalizado.`, 'success');
            } catch (error) {
                console.error("Erro ao finalizar atendimento:", error);
                showMessage('Erro ao finalizar atendimento. Tente novamente.', 'error');
            }
        }, 'Deseja realmente finalizar o atendimento do paciente atual?');
    };

    /**
     * Removes a specific patient from the queue.
     * @param {string} patientId - The ID of the patient document to remove.
     */
    const removePatientFromQueue = async (patientId) => {
        if (!db || !userId) {
            showMessage('Erro: Firebase não está pronto.', 'error');
            return;
        }

        showConfirmation(async () => {
            try {
                await deleteDoc(doc(db, `artifacts/${appId}/public/data/patients`, patientId));
                showMessage('Paciente removido da fila.', 'success');
            } catch (error) {
                console.error("Erro ao remover paciente:", error);
                showMessage('Erro ao remover paciente da fila. Tente novamente.', 'error');
            }
        }, 'Deseja realmente remover este paciente da fila?');
    };

    // ---------------------------------------------------
    // Render UI
    // ---------------------------------------------------
    return (
        <div className="min-h-screen bg-gray-100 font-sans antialiased text-gray-800 flex flex-col p-4 sm:p-6 lg:p-8">
            {/* Tailwind CSS CDN - Ensure it's loaded for styling */}
            <script src="https://cdn.tailwindcss.com"></script>
            {/* Font "Inter" for a clean look */}
            <style>
                {`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
                body {
                    font-family: 'Inter', sans-serif;
                }
                .scroll-container {
                    -ms-overflow-style: none; /* IE and Edge */
                    scrollbar-width: none; /* Firefox */
                }
                .scroll-container::-webkit-scrollbar {
                    display: none; /* Chrome, Safari, Opera */
                }
                `}
            </style>

            <header className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-4 sm:p-6 rounded-lg shadow-lg mb-6 text-center">
                <h1 className="text-3xl sm:text-4xl font-bold mb-2">Gerenciador de Senhas Hospitalar</h1>
                <p className="text-lg sm:text-xl opacity-90">Priorizando Atendimentos por Urgência</p>
                {userId && (
                    <div className="text-sm mt-2 opacity-80">
                        ID do Usuário: <span className="font-mono bg-white bg-opacity-20 px-2 py-1 rounded-md break-all">{userId}</span>
                    </div>
                )}
            </header>

            {/* Message Display */}
            {message.text && message.type !== 'confirm' && (
                <div className={`fixed top-4 right-4 p-4 rounded-lg shadow-xl z-50 transition-transform transform ${message.type === 'success' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-red-100 text-red-800 border border-red-200'} ${message.text ? 'translate-x-0' : 'translate-x-full'}`}>
                    {message.text}
                </div>
            )}

            {/* Confirmation Modal */}
            {showConfirmModal && (
                <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
                    <div className="bg-white p-6 rounded-lg shadow-xl max-w-sm w-full text-center">
                        <h3 className="text-xl font-semibold mb-4 text-gray-900">Confirmação Necessária</h3>
                        <p className="mb-6 text-gray-700">{message.text}</p>
                        <div className="flex justify-center space-x-4">
                            <button
                                onClick={handleConfirm}
                                className="px-6 py-2 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition duration-150 ease-in-out shadow-md"
                            >
                                Confirmar
                            </button>
                            <button
                                onClick={handleCancel}
                                className="px-6 py-2 bg-gray-300 text-gray-800 font-medium rounded-md hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 transition duration-150 ease-in-out shadow-md"
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <main className="flex flex-col lg:flex-row gap-6">
                {/* Panel Esquerdo: Adicionar Paciente e Controles */}
                <section className="bg-white p-6 rounded-lg shadow-md lg:w-1/3 flex-shrink-0">
                    <h2 className="text-2xl font-bold mb-4 text-gray-900 border-b pb-2">Adicionar Novo Paciente</h2>
                    <div className="mb-4">
                        <label htmlFor="patientName" className="block text-sm font-medium text-gray-700 mb-1">
                            Nome do Paciente (Opcional)
                        </label>
                        <input
                            type="text"
                            id="patientName"
                            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm transition duration-150 ease-in-out"
                            value={newPatientName}
                            onChange={(e) => setNewPatientName(e.target.value)}
                            placeholder="Ex: João Silva"
                        />
                    </div>
                    <div className="mb-6">
                        <label htmlFor="urgency" className="block text-sm font-medium text-gray-700 mb-1">
                            Categoria de Urgência
                        </label>
                        <select
                            id="urgency"
                            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm transition duration-150 ease-in-out"
                            value={newPatientUrgency}
                            onChange={(e) => setNewPatientUrgency(e.target.value)}
                        >
                            {urgencyLevels.map((level) => (
                                <option key={level.name} value={level.name}>
                                    {level.name} - {level.description}
                                </option>
                            ))}
                        </select>
                    </div>
                    <button
                        onClick={addPatient}
                        className="w-full bg-blue-600 text-white py-3 rounded-md font-semibold text-lg shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition duration-150 ease-in-out transform hover:scale-105"
                    >
                        Gerar Senha
                    </button>

                    <h2 className="text-2xl font-bold mt-8 mb-4 text-gray-900 border-b pb-2">Controles de Atendimento</h2>
                    <div className="space-y-4">
                        <button
                            onClick={callNextPatient}
                            className="w-full bg-green-600 text-white py-3 rounded-md font-semibold text-lg shadow-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 transition duration-150 ease-in-out transform hover:scale-105"
                        >
                            Chamar Próximo Paciente
                        </button>
                        <button
                            onClick={finishServing}
                            className="w-full bg-red-600 text-white py-3 rounded-md font-semibold text-lg shadow-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition duration-150 ease-in-out transform hover:scale-105"
                        >
                            Finalizar Atendimento Atual
                        </button>
                    </div>
                </section>

                {/* Painel Central: Paciente em Atendimento e Legenda de Urgência */}
                <section className="flex flex-col lg:w-2/3 gap-6">
                    <div className="bg-white p-6 rounded-lg shadow-md">
                        <h2 className="text-2xl font-bold mb-4 text-gray-900 border-b pb-2">Paciente em Atendimento</h2>
                        <div className="min-h-[120px] flex items-center justify-center p-4">
                            {currentServing ? (
                                <div className={`p-6 rounded-lg shadow-inner ${urgencyLevels.find(l => l.name === currentServing.urgency)?.color || 'bg-gray-200'} text-center w-full max-w-sm transform transition-transform duration-300 ease-in-out scale-100 hover:scale-105`}>
                                    <p className={`text-4xl sm:text-5xl font-extrabold ${urgencyLevels.find(l => l.name === currentServing.urgency)?.text || 'text-gray-800'}`}>
                                        {currentServing.password}
                                    </p>
                                    <p className={`text-xl font-semibold mt-2 ${urgencyLevels.find(l => l.name === currentServing.urgency)?.text || 'text-gray-700'}`}>
                                        ({currentServing.urgency})
                                    </p>
                                    <p className="text-md mt-1 text-gray-700">
                                        {currentServing.name}
                                    </p>
                                </div>
                            ) : (
                                <p className="text-xl text-gray-600">Nenhum paciente sendo atendido no momento.</p>
                            )}
                        </div>
                    </div>

                    <div className="bg-white p-6 rounded-lg shadow-md">
                        <h2 className="text-2xl font-bold mb-4 text-gray-900 border-b pb-2">Legenda de Urgência</h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {urgencyLevels.map((level) => (
                                <div key={level.name} className="flex items-center p-3 rounded-md bg-gray-50 border border-gray-200 shadow-sm">
                                    <div className={`w-6 h-6 rounded-full mr-3 ${level.color} flex-shrink-0`}></div>
                                    <div>
                                        <p className="font-semibold text-gray-800">{level.name}</p>
                                        <p className="text-sm text-gray-600">{level.description}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            </main>

            {/* Painel Inferior: Fila de Espera */}
            <section className="bg-white p-6 rounded-lg shadow-md mt-6">
                <h2 className="text-2xl font-bold mb-4 text-gray-900 border-b pb-2">Fila de Espera ({patients.length} pacientes)</h2>
                {patients.length === 0 ? (
                    <p className="text-lg text-gray-600 text-center py-4">A fila de espera está vazia.</p>
                ) : (
                    <div className="overflow-x-auto scroll-container">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider rounded-tl-lg">
                                        Senha
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Nome
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Urgência
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Chegada
                                    </th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider rounded-tr-lg">
                                        Ações
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {patients.map((patient) => {
                                    const urgencyInfo = urgencyLevels.find(l => l.name === patient.urgency);
                                    const time = patient.timestamp ? new Date(patient.timestamp.seconds * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'N/A';

                                    return (
                                        <tr key={patient.id} className="hover:bg-gray-50 transition-colors duration-150 ease-in-out">
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className={`font-semibold text-lg ${urgencyInfo?.text || 'text-gray-900'}`}>{patient.password}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm text-gray-900">{patient.name}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${urgencyInfo?.color || 'bg-gray-200'} ${urgencyInfo?.text || 'text-gray-800'}`}>
                                                    {patient.urgency}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm text-gray-500">{time}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                <button
                                                    onClick={() => removePatientFromQueue(patient.id)}
                                                    className="text-red-600 hover:text-red-900 ml-4 transition duration-150 ease-in-out transform hover:scale-110"
                                                    title="Remover da Fila"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 inline-block" viewBox="0 0 20 20" fill="currentColor">
                                                        <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 011-1h4a1 1 0 110 2H8a1 1 0 01-1-1zm1 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1zm1 3a1 1 0 000 2h2a1 1 0 100-2H9z" clipRule="evenodd" />
                                                    </svg>
                                                    <span className="sr-only">Remover</span>
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
