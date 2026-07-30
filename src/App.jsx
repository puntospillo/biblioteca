import React, { useState, useEffect, useRef } from 'react';
import { 
  BookOpen, CheckCircle, Circle, Star, Wand2, Sparkles, 
  Book, Bookmark, Search, Layers, Trash2, Plus, Image as ImageIcon, 
  RefreshCw, Download, Upload, FileSpreadsheet, Loader2, Settings, 
  Key, X, ArrowLeft, Library, SlidersHorizontal, Share2, Copy,
  ChevronUp, ChevronDown, UploadCloud, Move, ChevronsUp
} from 'lucide-react';

const appId = typeof window !== 'undefined' && window.__app_id ? window.__app_id : 'libri-di-maurizio';

// Incrementare a ogni modifica rilasciata (si parte da 2.0)
const APP_VERSION = '3.1';

const STATUSES = {
  ALL: { label: 'Tutti', value: 'ALL' },
  TO_READ: { label: 'Da Leggere', value: 'TO_READ', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  READING: { label: 'In Lettura', value: 'READING', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  READ: { label: 'Letti', value: 'READ', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' }
};

// Safe access to Firebase globals if loaded via script, otherwise initialize dynamically
let firebaseApp = null;
let authInstance = null;
let firestoreInstance = null;

const getFirebaseConfig = () => {
  try {
    const custom = localStorage.getItem('firebase_config');
    if (custom) {
      const parsed = JSON.parse(custom);
      if (parsed && parsed.apiKey) return parsed;
    }
  } catch (e) {
    console.error("Errore lettura firebase_config da localStorage:", e);
  }
  // Progetto Firebase reale (biblioteca-maurizio).
  // Nota: questi valori sono pubblici per definizione — la config web di Firebase
  // viaggia nel bundle JS di qualsiasi sito che la usa. I dati sono protetti dalle
  // regole Firestore, che legano ogni libro allo userId di chi lo ha creato.
  return {
    apiKey: "AIzaSyBHN9hyw9KEs-9C4lbzlq09xlPMPjpteN8",
    authDomain: "biblioteca-maurizio.firebaseapp.com",
    projectId: "biblioteca-maurizio",
    storageBucket: "biblioteca-maurizio.firebasestorage.app",
    messagingSenderId: "1032218389078",
    appId: "1:1032218389078:web:e5a2a4eed8705785f169f7"
  };
};

if (typeof window !== 'undefined') {
  if (window.auth && window.db) {
    authInstance = window.auth;
    firestoreInstance = window.db;
  } else if (window.firebase) {
    const config = getFirebaseConfig();
    try {
      if (window.firebase.apps.length === 0) {
        firebaseApp = window.firebase.initializeApp(config);
      } else {
        firebaseApp = window.firebase.app();
      }
      authInstance = window.firebase.auth();
      firestoreInstance = window.firebase.firestore();

      // Persistenza offline (cache locale Firestore).
      //
      // NON usare synchronizeTabs: con la persistenza multi-scheda una sola
      // scheda ottiene il "primary lease" e solo quella parla col server. Se
      // l'elezione non riesce — succede su Safari, dove IndexedDB e' limitato
      // dalle protezioni antitracciamento, o quando resta il lease di una
      // scheda chiusa male — le scritture finiscono in coda locale e
      // batch.commit() non si risolve mai: nessun errore, attesa infinita.
      // La cache a scheda singola da' comunque il beneficio che ci serve.
      //
      // Va inoltre abilitata una sola volta e prima di ogni altra operazione,
      // altrimenti Firestore lancia "failed-precondition".
      if (!window.__persistenzaFirestore) {
        window.__persistenzaFirestore = true;
        try {
          firestoreInstance.enablePersistence()
            .catch((err) => {
              // failed-precondition: gia' aperta in un'altra scheda
              // unimplemented: browser che non la supporta (es. Safari privato)
              console.warn("Persistenza offline non attiva:", err.code);
            });
        } catch (e) {
          console.warn("Persistenza offline non attivabile:", e.code || e.message);
        }
      }
    } catch (e) {
      console.error("Errore inizializzazione Firebase:", e);
    }
  }
}

const auth = authInstance;
const db = firestoreInstance;

// Gemini API: rileva automaticamente i modelli disponibili e li testa con chiamate reali
let verifiedModel = null;

const callGeminiAPI = async (prompt, systemInstruction = "", useSearch = false, expectJson = false, schema = null) => {
  const savedKey = (localStorage.getItem('gemini_api_key') || (import.meta.env ? import.meta.env.VITE_GEMINI_API_KEY : "") || "").trim();
  if (!savedKey) {
    throw new Error("CHIAVE_API_MANCANTE");
  }

  // Se abbiamo già un modello verificato, usalo direttamente
  const modelsToTry = [];
  if (verifiedModel) {
    modelsToTry.push(verifiedModel);
  } else {
    // Scopri i modelli disponibili sulla chiave API
    try {
      const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${savedKey}`);
      if (listRes.ok) {
        const listData = await listRes.json();
        const available = (listData.models || [])
          .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
          .map(m => m.name.replace('models/', ''));
        
        const preferred = [
          'gemini-2.0-flash',
          'gemini-2.0-flash-lite', 
          'gemini-2.5-flash-preview-05-20',
          'gemini-2.5-flash',
          'gemini-1.5-flash',
          'gemini-1.5-pro'
        ];
        
        for (const pref of preferred) {
          if (available.includes(pref)) modelsToTry.push(pref);
        }
        for (const m of available) {
          if (!modelsToTry.includes(m)) modelsToTry.push(m);
        }
      } else {
        const errJson = await listRes.json().catch(() => ({}));
        const msg = errJson.error?.message || '';
        if (msg.includes('API key not valid') || msg.includes('API_KEY_INVALID')) {
          throw new Error("Chiave API non valida. Generane una nuova da aistudio.google.com/app/apikey");
        }
      }
    } catch (e) {
      if (e.message.includes('Chiave API')) throw e;
    }
    
    if (modelsToTry.length === 0) {
      modelsToTry.push('gemini-2.0-flash', 'gemini-2.0-flash-lite');
    }
  }

  let lastErrorMsg = '';

  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${savedKey}`;
    
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: { 
        parts: [{ text: systemInstruction || "Sei un assistente bibliotecario esperto ed empatico. Rispondi sempre in italiano in modo chiaro e ben strutturato." }] 
      }
    };
    
    // Attenzione: Gemini non accetta lo strumento di ricerca Google insieme
    // all'output strutturato JSON — la richiesta viene rifiutata. Quando
    // serve un JSON si rinuncia alla ricerca, che e' la combinazione che
    // faceva tornare sempre vuote le sezioni Bestseller e Novita'.
    if (useSearch && !expectJson) payload.tools = [{ "googleSearch": {} }];
    if (expectJson) {
      payload.generationConfig = { responseMimeType: "application/json" };
      // Con il solo responseMimeType il modello resta libero di incapsulare
      // l'elenco in un oggetto ({"libri": [...]}). Lo schema impone la forma
      // esatta ed e' cio' che rende la risposta davvero utilizzabile.
      if (schema) payload.generationConfig.responseSchema = schema;
    }

    try {
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok && useSearch) {
        const payloadNoSearch = { ...payload };
        delete payloadNoSearch.tools;
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadNoSearch)
        });
        if (retryRes.ok) res = retryRes;
      }

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          verifiedModel = model;
          return text;
        }
      }

      const errJson = await res.json().catch(() => ({}));
      const rawMsg = errJson.error?.message || `HTTP ${res.status}`;
      
      if (rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID')) {
        throw new Error("Chiave API non valida. Generane una nuova da aistudio.google.com/app/apikey");
      }

      lastErrorMsg = rawMsg;
      continue;
    } catch (e) {
      if (e.message.includes('Chiave API')) throw e;
      lastErrorMsg = e.message;
    }
  }

  verifiedModel = null;
  throw new Error(`Errore Gemini: ${lastErrorMsg}`);
};

// Triple-Engine Cover Fetching (Apple Books -> Google Books -> OpenLibrary)
// Novita' editoriali italiane da dati reali (classifiche Apple Books Italia).
// Chiedere le classifiche a un modello linguistico non funziona: non le
// conosce, e nel tentativo di inventarle produce titoli degeneri. Qui invece
// i dati sono veri, aggiornati ogni giorno e non richiedono chiavi API.
const pulisciHtml = (testo = '') => {
  const t = document.createElement('textarea');
  t.innerHTML = testo.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  return t.value.replace(/\s+/g, ' ').trim();
};

// Nota sulla scelta della fonte: il feed moderno
// (rss.marketingtools.apple.com) non invia gli header CORS, quindi dal browser
// e' inutilizzabile. Il feed storico su itunes.apple.com li invia, e in piu'
// include gia' le trame: una sola richiesta per classifica.
const dataDaFeed = (voce) => {
  const iso = voce?.['im:releaseDate']?.label;
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d)) return d;
  }
  // Ripiego sul formato visualizzato gg/mm/aaaa
  const testo = voce?.['im:releaseDate']?.attributes?.label || '';
  const m = testo.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`);
  return new Date(0);
};

const fetchNovitaItalia = async (quanti = 30) => {
  const classifica = async (tipo) => {
    const res = await fetch(`https://itunes.apple.com/it/rss/${tipo}/limit=100/json`);
    if (!res.ok) throw new Error(`Il servizio classifiche ha risposto ${res.status}`);
    const data = await res.json();
    return data?.feed?.entry || [];
  };

  const [aPagamento, gratuiti] = await Promise.all([
    classifica('toppaidebooks').catch(e => { console.warn('classifica a pagamento:', e); return []; }),
    classifica('topfreeebooks').catch(e => { console.warn('classifica gratuiti:', e); return []; })
  ]);

  const tutti = [...aPagamento, ...gratuiti];
  if (tutti.length === 0) {
    throw new Error("Impossibile raggiungere il servizio delle classifiche italiane. Controlla la connessione e riprova.");
  }

  // Unisce le due classifiche, elimina i doppioni e privilegia le uscite piu'
  // recenti: e' questo a renderlo un elenco di novita' e non un "best of",
  // dove i classici di pubblico dominio occuperebbero le prime posizioni.
  const perId = new Map();
  tutti.forEach(v => {
    const id = v?.id?.attributes?.['im:id'];
    if (id && !perId.has(id)) perId.set(id, v);
  });

  const ordinati = [...perId.values()]
    .sort((a, b) => dataDaFeed(b) - dataDaFeed(a))
    .slice(0, quanti);

  return ordinati.map(v => {
    const immagini = v['im:image'] || [];
    const piuGrande = immagini.length ? immagini[immagini.length - 1].label : '';
    return {
      volumeInfo: {
        title: v['im:name']?.label || 'Senza titolo',
        authors: [v['im:artist']?.label || 'Sconosciuto'],
        description: pulisciHtml(v.summary?.label || ''),
        publishedDate: dataDaFeed(v).toISOString(),
        publisher: v['im:publisher']?.label || '',
        infoLink: v.link?.attributes?.href || '',
        // Le miniature del feed sono minuscole: la dimensione e' nell'URL
        imageLinks: piuGrande ? { thumbnail: piuGrande.replace(/\/\d+x\d+bb/, '/600x600bb') } : null
      }
    };
  });
};

const secureCoverFetch = async (title, author = '') => {
  const queryStr = encodeURIComponent(`${title} ${author}`.trim());
  
  // 1. Apple iTunes / Books API (HD Covers, No Rate Limits)
  try {
    const itRes = await fetch(`https://itunes.apple.com/search?term=${queryStr}&entity=ebook&country=it&limit=1`);
    if (itRes.ok) {
      const itData = await itRes.json();
      if (itData.results?.[0]?.artworkUrl100) {
        return itData.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
      }
    }
  } catch (e) {}

  // 2. Google Books Fallback
  try {
    const gbRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}+inauthor:${encodeURIComponent(author)}&maxResults=1&langRestrict=it`);
    if (gbRes.ok) {
      const gbData = await gbRes.json();
      const gbCover = gbData.items?.[0]?.volumeInfo?.imageLinks?.thumbnail;
      if (gbCover) return gbCover.replace('http:', 'https:');
    }
  } catch (e) {}

  // 3. OpenLibrary Fallback
  try {
    const olRes = await fetch(`https://openlibrary.org/search.json?q=${queryStr}&limit=1`);
    if (olRes.ok) {
      const olData = await olRes.json();
      if (olData.docs?.[0]?.cover_i) {
        return `https://covers.openlibrary.org/b/id/${olData.docs[0].cover_i}-M.jpg`;
      }
    }
  } catch (e) {}

  return "";
};

const generateUniqueId = () => Math.random().toString(36).substring(2, 11) + Date.now().toString(36);

const Card = ({ children, className = "" }) => (
  <div className={`bg-white rounded-2xl shadow-sm border border-slate-200 transition-all ${className}`}>
    {children}
  </div>
);

const Button = ({ children, onClick, variant = 'primary', className = '', disabled = false, icon: Icon, loading = false }) => {
  const base = "flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold transition-all active:scale-95 disabled:opacity-50 text-xs whitespace-nowrap cursor-pointer";
  const variants = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 shadow-sm",
    secondary: "bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200",
    outline: "border border-slate-300 text-slate-700 hover:bg-slate-50",
    danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
    ghost: "text-slate-600 hover:bg-slate-100",
    ai: "bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:shadow-indigo-100 shadow-md"
  };
  return (
    <button onClick={onClick} className={`${base} ${variants[variant]} ${className}`} disabled={disabled || loading}>
      {loading ? <Loader2 size={15} className="animate-spin" /> : Icon && <Icon size={15} />}
      {children}
    </button>
  );
};

const StatCard = ({ label, value, icon: Icon, color }) => {
  const colors = { 
    blue: "text-blue-600 bg-blue-50 border-l-blue-500", 
    green: "text-emerald-600 bg-emerald-50 border-l-emerald-500", 
    amber: "text-amber-600 bg-amber-50 border-l-amber-500", 
    purple: "text-purple-600 bg-purple-50 border-l-purple-500" 
  };
  return (
    <Card className={`p-4 border-l-4 ${colors[color]} rounded-xl shadow-sm`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-black text-slate-800 mt-0.5">{value}</p>
        </div>
        <div className={`p-3 rounded-xl ${colors[color]}`}>
          <Icon size={22} />
        </div>
      </div>
    </Card>
  );
};
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center bg-red-50 rounded-2xl border border-red-200 max-w-md mx-auto my-12">
          <h3 className="text-lg font-black text-red-700 mb-2">Si è verificato un problema con questi dati</h3>
          <p className="text-xs text-red-600 mb-4">{this.state.error?.message || 'Si è verificato un errore nei dati del libro.'}</p>
          <button 
            onClick={() => { this.setState({ hasError: false }); window.location.reload(); }} 
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl cursor-pointer shadow"
          >
            Ricarica Applicazione
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const mergeBooksLists = (local, cloud) => {
  const mergedMap = new Map();
  local.forEach(b => {
    if (b.id) mergedMap.set(b.id, b);
  });
  cloud.forEach(cb => {
    const lb = mergedMap.get(cb.id);
    if (!lb) {
      mergedMap.set(cb.id, cb);
    } else {
      const localTime = new Date(lb.updatedAt || 0).getTime();
      const cloudTime = new Date(cb.updatedAt || 0).getTime();
      if (cloudTime >= localTime) {
        mergedMap.set(cb.id, cb);
      }
    }
  });
  return Array.from(mergedMap.values());
};

export default function App() {
  const [user, setUser] = useState(null);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  
  // Firebase client-side config state
  const [fbApiKey, setFbApiKey] = useState(() => localStorage.getItem('fb_apiKey') || '');
  const [fbProjectId, setFbProjectId] = useState(() => localStorage.getItem('fb_projectId') || '');
  const [fbAuthDomain, setFbAuthDomain] = useState(() => localStorage.getItem('fb_authDomain') || '');
  const [fbAppId, setFbAppId] = useState(() => localStorage.getItem('fb_appId') || '');

  const [books, setBooks] = useState(() => {
    try {
      const cached = localStorage.getItem('myBooksData_cloud_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    return [
      {
        id: 'demo-1',
        title: 'Il nome della rosa',
        firstName: 'Umberto',
        lastName: 'Eco',
        coverUrl: 'https://m.media-amazon.com/images/I/71rpa1-3vLL._AC_UF1000,1000_QL80_.jpg',
        status: 'READ',
        rating: 5,
        isNextRead: false,
        daScaricare: false,
        description: 'Ambientato nel 1327 in un\'abbazia benedettina nell\'Italia settentrionale, il frate Guglielmo da Baskerville indaga su una serie di morti misteriose.',
        notes: 'Capolavoro assoluto della letteratura italiana.',
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'demo-2',
        title: 'Se questo è un uomo',
        firstName: 'Primo',
        lastName: 'Levi',
        coverUrl: '',
        status: 'READING',
        rating: 5,
        isNextRead: false,
        daScaricare: false,
        description: 'Testimonianza drammatica e lucidissima dell\'esperienza dell\'autore nel campo di concentramento di Auschwitz.',
        notes: 'Lettura fondamentale per la memoria storica.',
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'demo-3',
        title: 'Le città invisibili',
        firstName: 'Italo',
        lastName: 'Calvino',
        coverUrl: '',
        status: 'TO_READ',
        rating: 0,
        isNextRead: true,
        daScaricare: true,
        description: 'Dialogo immaginario tra Marco Polo e l\'imperatore Kublai Khan sulle città dell\'impero.',
        notes: 'In coda per la lettura estiva.',
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
  });

  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedBook, setSelectedBook] = useState(null);
  const [toast, setToast] = useState(null);
  const [aiModal, setAiModal] = useState({ isOpen: false, title: '', content: '', loading: false });

  // Cache per ricerche ed esplorazione online
  const [bestsellerResults, setBestsellerResults] = useState([]);
  const [novitaResults, setNovitaResults] = useState([]);
  const [cercaResults, setCercaResults] = useState({ q: '', items: [] });

  // Sincronizzazione e stati avanzati
  const [syncStatus, setSyncStatus] = useState('offline'); // 'offline', 'syncing', 'synced', 'error'
  const [isSyncing, setIsSyncing] = useState(false);
  // Avanzamento dell'importazione: { fatti, totale } oppure null
  const [importProgress, setImportProgress] = useState(null);
  // Copia sempre aggiornata dei libri, leggibile dentro i callback di Firestore
  const booksRef = useRef([]);
  // Evita che una riconciliazione parta mentre un'altra e' in corso: ogni
  // blocco scritto genera un nuovo snapshot, che la farebbe ripartire.
  const riconciliazioneInCorso = useRef(false);
  const [starFilters, setStarFilters] = useState(() => {
    try {
      const saved = localStorage.getItem('libreria_star_filters');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    return []; // vuoto = tutti
  });

  // Paginazione delle 4 sezioni (limiti mostrati, incrementabili di 30 alla volta)
  const [limits, setLimits] = useState({
    inLettura: 30,
    daScaricare: 30,
    preferiti: 30,
    giaLetti: 30,
    daLeggere: 30
  });

  // Liste di ordinamento manuale persistenti
  // Init da localStorage: l'ordine sopravvive al refresh anche prima che arrivi il cloud
  const loadOrder = (key) => {
    try {
      const saved = localStorage.getItem(`libreria_order_${key}`);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return [];
  };
  const [inLetturaOrder, setInLetturaOrder] = useState(() => loadOrder('inLettura'));
  const [preferitiOrder, setPreferitiOrder] = useState(() => loadOrder('preferiti'));
  const [giaLettiOrder, setGiaLettiOrder] = useState(() => loadOrder('giaLetti'));
  const [daLeggereOrder, setDaLeggereOrder] = useState(() => loadOrder('daLeggere'));
  const [libreriaOrder, setLibreriaOrder] = useState(() => loadOrder('libreria'));
  const [daScaricareOrder, setDaScaricareOrder] = useState(() => loadOrder('daScaricare'));
  // Ultimo libro salvato: resta in cima a ogni elenco finche' non se ne salva
  // un altro, cosi' dopo un salvataggio lo si ritrova subito invece di doverlo
  // cercare tra migliaia di voci. Persistito per sopravvivere al ricaricamento.
  const [ultimoSalvatoId, setUltimoSalvatoId] = useState(
    () => { try { return localStorage.getItem('libreria_ultimo_salvato') || ''; } catch (e) { return ''; } }
  );
  
  // Memorizzazione ultima ricerca ed esplorazione
  const [lastSearch, setLastSearch] = useState({
    bestseller: { query: '', results: [] },
    novita: { query: '', results: [] }
  });

  // Funzione per salvare le impostazioni/ordine sul cloud
  const saveSettingsToCloud = (updatedSettings) => {
    if (!db || !user) return;
    db.collection('users').doc(user.uid).collection('settings').doc('app')
      .set(updatedSettings, { merge: true })
      .catch(err => console.error("Errore salvataggio settings cloud:", err));
  };

  // Monitoraggio stato autenticazione
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = auth.onAuthStateChanged((firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        setSyncStatus('syncing');
        showToast(`Accesso effettuato come ${firebaseUser.email}`);
      } else {
        setSyncStatus('offline');
      }
    });
    return () => unsubscribe();
  }, []);

  // Sincronizzazione in tempo reale con Firestore
  useEffect(() => {
    if (!db || !user) {
      setSyncStatus('offline');
      return;
    }

    setIsSyncing(true);
    setSyncStatus('syncing');

    // Sottoscrizione ai libri
    const unsubscribeBooks = db.collection('books')
      .where('userId', '==', user.uid)
      .onSnapshot(
        (snapshot) => {
          const cloudBooks = [];
          snapshot.forEach((doc) => {
            cloudBooks.push(doc.data());
          });

          const localBooks = booksRef.current || [];
          const merged = mergeBooksLists(localBooks, cloudBooks);
          setBooks(merged);
          try {
            localStorage.setItem('myBooksData_cloud_cache', JSON.stringify(merged));
          } catch (e) {}

          // Riconciliazione: individua i libri locali assenti dal cloud o piu'
          // recenti. Confronto tramite Map: con migliaia di libri una find()
          // annidata costerebbe milioni di scansioni.
          const cloudMap = new Map(cloudBooks.map(b => [b.id, b]));
          const daCaricare = localBooks
            .filter(lb => {
              const cb = cloudMap.get(lb.id);
              return !cb || new Date(lb.updatedAt || 0).getTime() > new Date(cb.updatedAt || 0).getTime();
            })
            .map(lb => normalizeBook(lb, user.uid, { preservaData: true }));

          if (daCaricare.length > 0 && !riconciliazioneInCorso.current) {
            riconciliazioneInCorso.current = true;
            setSyncStatus('syncing');
            setImportProgress({ fatti: 0, totale: daCaricare.length });
            caricaLibriInBlocchi(daCaricare, {
              onProgresso: (fatti, totale) => setImportProgress({ fatti, totale })
            }).then(({ salvati, falliti, primoErrore }) => {
              setImportProgress(null);
              if (falliti > 0) {
                setSyncStatus('error');
                showToast(
                  `Sincronizzazione cloud fallita per ${falliti} libri (${primoErrore?.code || 'errore sconosciuto'}).`,
                  "error"
                );
              } else {
                setSyncStatus('synced');
                if (salvati > 0) showToast(`Sincronizzati ${salvati} libri sul cloud.`);
              }
            }).finally(() => {
              riconciliazioneInCorso.current = false;
            });
          } else if (!riconciliazioneInCorso.current) {
            setSyncStatus('synced');
          }
          setIsSyncing(false);
        },
        (error) => {
          console.error("Firestore Books Sync Error:", error);
          setSyncStatus('error');
          setIsSyncing(false);
        }
      );

    // Sottoscrizione alle impostazioni (ordinamento manuale, filtri, ultima ricerca)
    const unsubscribeSettings = db.collection('users').doc(user.uid).collection('settings').doc('app')
      .onSnapshot(
        (doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data.inLetturaOrder) setInLetturaOrder(data.inLetturaOrder);
            if (data.preferitiOrder) setPreferitiOrder(data.preferitiOrder);
            if (data.giaLettiOrder) setGiaLettiOrder(data.giaLettiOrder);
            if (data.daLeggereOrder) setDaLeggereOrder(data.daLeggereOrder);
            if (data.libreriaOrder) setLibreriaOrder(data.libreriaOrder);
            if (data.daScaricareOrder) setDaScaricareOrder(data.daScaricareOrder);
            if (data.starFilters) {
              setStarFilters(data.starFilters);
              localStorage.setItem('libreria_star_filters', JSON.stringify(data.starFilters));
            }
            if (data.lastSearch) {
              setLastSearch(data.lastSearch);
              if (data.lastSearch.bestseller && data.lastSearch.bestseller.results) {
                setBestsellerResults(data.lastSearch.bestseller.results);
              }
              if (data.lastSearch.novita && data.lastSearch.novita.results) {
                setNovitaResults(data.lastSearch.novita.results);
              }
            }
          }
        },
        (error) => {
          console.error("Firestore Settings Sync Error:", error);
        }
      );

    return () => {
      unsubscribeBooks();
      unsubscribeSettings();
    };
  }, [user]);

  // Backup in LocalStorage come cache
  useEffect(() => {
    booksRef.current = books;
    try {
      localStorage.setItem('myBooksData_cloud_cache', JSON.stringify(books));
    } catch (e) {
      console.warn("Impossibile salvare cache in localStorage:", e);
    }
  }, [books]);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const openApiKeySettings = () => {
    setIsSettingsOpen(true);
  };

  const handleSaveApiKey = (newKey) => {
    const trimmed = newKey.trim();
    setApiKey(trimmed);
    localStorage.setItem('gemini_api_key', trimmed);
    setIsSettingsOpen(false);
    showToast("Chiave API Gemini salvata!", "success");
  };

  const navigateTo = (tab) => {
    setActiveTab(tab);
    setSelectedBook(null);
  };

  const openBookDetails = (book) => {
    if (!book) return;
    setSelectedBook(book);
    setActiveTab('scheda_libro');
  };

  // Normalizza un libro nella forma salvata su Firestore.
  // preservaData serve all'importazione: riscrivere updatedAt con "adesso" su
  // tutti i libri appiattirebbe le date e distruggerebbe l'ordinamento per
  // ultima modifica su cui si basano le sezioni della dashboard.
  const normalizeBook = (bookData, uid, { preservaData = false } = {}) => {
    const bookId = bookData.id || generateUniqueId();
    return {
      id: bookId,
      title: (bookData.title || 'Senza Titolo').trim(),
      firstName: (bookData.firstName || '').trim(),
      lastName: (bookData.lastName || 'Sconosciuto').trim(),
      coverUrl: (bookData.coverUrl || '').trim(),
      status: bookData.status || 'TO_READ',
      rating: Number(bookData.rating) || 0,
      isNextRead: !!bookData.isNextRead,
      daScaricare: !!bookData.daScaricare,
      description: (bookData.description || '').trim(),
      notes: (bookData.notes || '').trim(),
      comments: (bookData.comments || '').trim(),
      addedAt: bookData.addedAt || new Date().toISOString(),
      updatedAt: (preservaData && bookData.updatedAt) ? bookData.updatedAt : new Date().toISOString(),
      startReadDate: bookData.startReadDate || '',
      endReadDate: bookData.endReadDate || '',
      readingProgress: bookData.readingProgress || '',
      readingPercentage: Number(bookData.readingPercentage) || 0,
      currentPage: Number(bookData.currentPage) || 0,
      userId: uid
    };
  };

  // Carica una lista di libri su Firestore in blocchi.
  // Unico punto di scrittura massiva: usarlo sia per l'importazione sia per la
  // riconciliazione evita che le due si ostacolino a vicenda inondando la
  // connessione di scritture singole simultanee.
  const caricaLibriInBlocchi = async (libri, { onProgresso } = {}) => {
    const DIMENSIONE_BLOCCO = 200;
    const TIMEOUT_MS = 30000;
    let salvati = 0;
    let falliti = 0;
    let primoErrore = null;

    // batch.commit() si risolve solo quando il server conferma la scrittura:
    // se il client non raggiunge Firestore resta appeso per sempre, senza mai
    // rifiutare. Il timeout trasforma quel blocco silenzioso in un errore
    // leggibile invece che in una barra di avanzamento ferma a zero.
    const conTimeout = (promessa) => Promise.race([
      promessa,
      new Promise((_, rifiuta) => setTimeout(() => {
        const e = new Error("Nessuna risposta dal database entro 30 secondi. Verifica la connessione o eventuali blocchi del browser.");
        e.code = 'timeout';
        rifiuta(e);
      }, TIMEOUT_MS))
    ]);

    for (let i = 0; i < libri.length; i += DIMENSIONE_BLOCCO) {
      const blocco = libri.slice(i, i + DIMENSIONE_BLOCCO);
      try {
        const batch = db.batch();
        blocco.forEach(b => batch.set(db.collection('books').doc(b.id), b));
        await conTimeout(batch.commit());
        salvati += blocco.length;
      } catch (err) {
        falliti += blocco.length;
        if (!primoErrore) primoErrore = err;
        console.error("Errore scrittura blocco Firestore:", err?.code, err?.message, err);
        // Un timeout o un permesso negato valgono per tutti i blocchi:
        // insistere significherebbe solo far attendere l'utente altri minuti.
        if (err?.code === 'timeout' || err?.code === 'permission-denied') {
          falliti = libri.length - salvati;
          break;
        }
      }
      if (onProgresso) onProgresso(Math.min(i + DIMENSIONE_BLOCCO, libri.length), libri.length);
    }
    return { salvati, falliti, primoErrore };
  };

  // portaInCima: riservato ai salvataggi espliciti (scheda libro, aggiunta da
  // ricerca web). Le modifiche rapide dalle righe — stelle, stato, flag —
  // passano di qui a ogni clic: farle saltare in cima sposterebbe il libro
  // sotto il dito mentre lo si sta usando.
  const saveBookToCloud = async (bookData, { portaInCima = false } = {}) => {
    if (!bookData) return;
    const cleanBook = normalizeBook(bookData, user ? user.uid : 'local-user');
    const bookId = cleanBook.id;

    if (portaInCima) {
      setUltimoSalvatoId(bookId);
      try { localStorage.setItem('libreria_ultimo_salvato', bookId); } catch (e) {}
      // Se il libro compare in un ordine manuale resterebbe inchiodato alla
      // sua vecchia posizione: togliendolo torna "non ordinato" e risale.
      Object.keys(ORDER_FIELDS).forEach(sezione => {
        const attuale = {
          inLettura: inLetturaOrder, preferiti: preferitiOrder, giaLetti: giaLettiOrder,
          daLeggere: daLeggereOrder, libreria: libreriaOrder, daScaricare: daScaricareOrder
        }[sezione] || [];
        if (attuale.includes(bookId)) {
          persistSectionOrder(sezione, attuale.filter(id => id !== bookId));
        }
      });
    }

    // Aggiorna lo stato locale immediatamente
    setBooks(prev => {
      const exists = prev.some(b => b.id === bookId);
      if (exists) {
        return prev.map(b => b.id === bookId ? cleanBook : b);
      }
      return [cleanBook, ...prev];
    });

    // Salva su Firestore se connessi
    if (db && user) {
      setSyncStatus('syncing');
      db.collection('books').doc(bookId).set(cleanBook)
        .then(() => setSyncStatus('synced'))
        .catch(err => {
          console.error("Errore salvataggio Firestore:", err);
          setSyncStatus('error');
          showToast("Salvataggio locale eseguito. Sync cloud fallito.", "error");
        });
    }

    showToast("Libro salvato con successo nella tua libreria!");
  };

  const deleteBookFromCloud = async (bookId) => {
    if (!bookId) return;
    setBooks(prev => prev.filter(b => b.id !== bookId));
    
    if (db && user) {
      setSyncStatus('syncing');
      db.collection('books').doc(bookId).delete()
        .then(() => setSyncStatus('synced'))
        .catch(err => {
          console.error("Errore eliminazione Firestore:", err);
          setSyncStatus('error');
        });
    }
    showToast("Libro eliminato dalla libreria!");
  };

  // --- Ordinamento manuale per sezione ---------------------------------
  // Ogni sezione ha una lista di id. I libri elencati vengono prima, nell'ordine
  // indicato; gli altri restano nell'ordine automatico (sort stabile).
  const ORDER_SETTERS = {
    inLettura: setInLetturaOrder,
    preferiti: setPreferitiOrder,
    giaLetti: setGiaLettiOrder,
    daLeggere: setDaLeggereOrder,
    libreria: setLibreriaOrder,
    daScaricare: setDaScaricareOrder
  };
  const ORDER_FIELDS = {
    inLettura: 'inLetturaOrder',
    preferiti: 'preferitiOrder',
    giaLetti: 'giaLettiOrder',
    daLeggere: 'daLeggereOrder',
    libreria: 'libreriaOrder',
    daScaricare: 'daScaricareOrder'
  };

  // Filtro stelle a selezione multipla. 0 = libri senza valutazione.
  // Elenco vuoto = nessun filtro attivo.
  const toggleStarFilter = (valore) => {
    setStarFilters(prev => {
      const nuovo = prev.includes(valore) ? prev.filter(v => v !== valore) : [...prev, valore];
      try { localStorage.setItem('libreria_star_filters', JSON.stringify(nuovo)); } catch (e) {}
      saveSettingsToCloud({ starFilters: nuovo });
      return nuovo;
    });
  };

  const applyManualOrder = (list, orderIds) => {
    if (!orderIds || orderIds.length === 0) return list;
    const pos = new Map(orderIds.map((id, i) => [id, i]));
    // I libri non presenti nell'ordine manuale sono quelli entrati nella
    // sezione dopo l'ultimo riordino: vanno in cima, dove li metterebbe
    // l'ordinamento automatico per data. Mandandoli in fondo (com'era prima)
    // un libro appena letto finiva oltre il trecentesimo posto e spariva
    // sotto il limite di 30 mostrati, facendo sembrare rotto il riordino.
    return [...list].sort((a, b) => {
      const pa = pos.has(a.id) ? pos.get(a.id) : -1;
      const pb = pos.has(b.id) ? pos.get(b.id) : -1;
      return pa - pb;
    });
  };

  const persistSectionOrder = (sectionKey, ids) => {
    const setter = ORDER_SETTERS[sectionKey];
    if (setter) setter(ids);
    try {
      localStorage.setItem(`libreria_order_${sectionKey}`, JSON.stringify(ids));
    } catch (e) {}
    saveSettingsToCloud({ [ORDER_FIELDS[sectionKey]]: ids });
  };

  // Sposta un libro su/giù restando dentro il proprio gruppo.
  // fullOrder permette a "Da leggere" di salvare entrambi i gruppi (senza flag
  // + con flag "Da scaricare") mantenendo i secondi sempre in coda.
  const moveInSection = (sectionKey, group, bookId, direction, fullOrder = null) => {
    const index = group.findIndex(b => b.id === bookId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= group.length) return;

    const ids = group.map(b => b.id);
    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];

    const newOrder = fullOrder
      ? fullOrder.map(g => (g === group ? ids : g.map(b => b.id))).flat()
      : ids;
    persistSectionOrder(sectionKey, newOrder);
  };

  // Porta un libro al primo posto della sua sezione. Con liste di centinaia
  // di voci, risalire premendo la freccia su decine di volte e' impraticabile.
  const portaInCimaSezione = (sectionKey, group, bookId, fullOrder = null) => {
    const ids = group.map(b => b.id).filter(id => id !== bookId);
    ids.unshift(bookId);
    const newOrder = fullOrder
      ? fullOrder.map(g => (g === group ? ids : g.map(b => b.id))).flat()
      : ids;
    persistSectionOrder(sectionKey, newOrder);
  };

  // Riordino via drag & drop dentro la stessa sezione: inserisce il libro
  // trascinato prima di quello su cui viene rilasciato.
  const reorderInSection = (sectionKey, group, draggedId, targetId, fullOrder = null) => {
    if (draggedId === targetId) return;
    const ids = group.map(b => b.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);

    const newOrder = fullOrder
      ? fullOrder.map(g => (g === group ? ids : g.map(b => b.id))).flat()
      : ids;
    persistSectionOrder(sectionKey, newOrder);
  };

  const handleAiCallWithCheck = async (prompt, systemInstruction = "", useSearch = false, expectJson = false, schema = null) => {
    try {
      return await callGeminiAPI(prompt, systemInstruction, useSearch, expectJson, schema);
    } catch (err) {
      if (err.message === 'CHIAVE_API_MANCANTE') {
        setIsSettingsOpen(true);
        throw new Error("Inserisci la tua chiave API Gemini per attivare l'assistente AI.");
      }
      throw err;
    }
  };

  // 1. Dashboard View (Release 2.0 - 4 Sezioni)
  const DashboardView = () => {
    const total = books.length;
    const readBooks = books.filter(b => b.status === 'READ');
    const readCount = readBooks.length;
    const readingCount = books.filter(b => b.status === 'READING').length;
    const toReadCount = books.filter(b => b.status === 'TO_READ').length;
    
    const ratedReadBooks = readBooks.filter(b => b.rating > 0);
    const avgRating = ratedReadBooks.length > 0 
      ? (ratedReadBooks.reduce((sum, b) => sum + Number(b.rating), 0) / ratedReadBooks.length).toFixed(1) 
      : '0.0';

    const byRecent = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);

    // Sezione 1: In Lettura - per data di ultima modifica, poi ordine manuale
    const inLetturaBooks = applyManualOrder(
      books.filter(b => b.status === 'READING').sort(byRecent),
      inLetturaOrder
    );

    // Sezione "Da Scaricare": tutti i libri col flag, a prescindere dallo stato
    const daScaricareBooks = applyManualOrder(
      books.filter(b => b.daScaricare).sort(byRecent),
      daScaricareOrder
    );

    // Sezione 2: Preferiti - 5 stelle, poi 4 stelle, poi updatedAt; infine ordine manuale
    const preferitiBooks = applyManualOrder(
      books.filter(b => (b.rating || 0) >= 4).sort((a, b) => {
        if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
        return byRecent(a, b);
      }),
      preferitiOrder
    );

    // Sezione 3: Già Letti - per data di ultima modifica, poi ordine manuale
    const giaLettiBooks = applyManualOrder(readBooks.slice().sort(byRecent), giaLettiOrder);

    // Sezione 4: Da Leggere - solo i libri marcati "In Coda" (isNextRead).
    // Con quasi 3000 libri da leggere, l'elenco completo e' inutilizzabile:
    // qui va la selezione che si vuole leggere davvero.
    // Restano due gruppi: quelli con flag "Da scaricare" sempre in fondo.
    const daLeggereAll = books.filter(b => b.status === 'TO_READ' && b.isNextRead);
    const daLeggereG1 = applyManualOrder(
      daLeggereAll.filter(b => !b.daScaricare).sort(byRecent), daLeggereOrder
    );
    const daLeggereG2 = applyManualOrder(
      daLeggereAll.filter(b => !!b.daScaricare).sort(byRecent), daLeggereOrder
    );
    const daLeggereGroups = [daLeggereG1, daLeggereG2];
    const daLeggereBooks = [...daLeggereG1, ...daLeggereG2];

    // Drag & Drop: si trascina fra sezioni (cambia stato) oppure sopra un altro
    // libro della stessa sezione (riordino manuale).
    const handleDragStart = (e, bookId, fromSection = '') => {
      e.dataTransfer.setData('text/plain', bookId);
      e.dataTransfer.setData('application/x-sezione', fromSection);
      e.dataTransfer.effectAllowed = 'move';
    };

    const handleDropOnBook = (e, sectionKey, group, targetId, fullOrder = null) => {
      const draggedId = e.dataTransfer.getData('text/plain');
      const fromSection = e.dataTransfer.getData('application/x-sezione');
      // Solo dentro la stessa sezione e lo stesso gruppo: altrimenti lascio
      // gestire al drop sulla sezione, che cambia stato.
      if (!draggedId || fromSection !== sectionKey) return false;
      if (!group.some(b => b.id === draggedId)) return false;
      e.preventDefault();
      e.stopPropagation();
      reorderInSection(sectionKey, group, draggedId, targetId, fullOrder);
      return true;
    };

    const handleDropOnSection = (e, targetSection) => {
      e.preventDefault();
      const bookId = e.dataTransfer.getData('text/plain');
      if (!bookId) return;
      // Riordino interno già gestito dal drop sulla riga
      if (e.dataTransfer.getData('application/x-sezione') === targetSection) return;
      const targetBook = books.find(b => b.id === bookId);
      if (!targetBook) return;
      let updatedBook = { ...targetBook };
      if (targetSection === 'inLettura') {
        updatedBook.status = 'READING';
        showToast(`"${targetBook.title}" spostato In Lettura!`);
      } else if (targetSection === 'preferiti') {
        updatedBook.rating = 5;
        showToast(`"${targetBook.title}" spostato nei Preferiti (5★)!`);
      } else if (targetSection === 'daScaricare') {
        updatedBook.daScaricare = true;
        showToast(`"${targetBook.title}" segnato come Da Scaricare!`);
      } else if (targetSection === 'giaLetti') {
        updatedBook.status = 'READ';
        showToast(`"${targetBook.title}" spostato nei Già Letti!`);
      } else if (targetSection === 'daLeggere') {
        // La sezione mostra solo i libri "In Coda": senza alzare il flag il
        // libro trascinato qui sparirebbe subito dalla vista.
        updatedBook.status = 'TO_READ';
        updatedBook.isNextRead = true;
        showToast(`"${targetBook.title}" messo in coda tra i Da Leggere!`);
      }
      saveBookToCloud(updatedBook);
    };

    // Inline Star Rating
    const InlineStars = ({ book }) => (
      <div className="flex gap-0.5">
        {[1,2,3,4,5].map(s => (
          <button key={s} onClick={(e) => { e.stopPropagation(); saveBookToCloud({...book, rating: book.rating === s ? 0 : s}); }}
            className="cursor-pointer p-0 border-0 bg-transparent">
            <Star size={12} className={s <= (book.rating || 0) ? 'fill-yellow-400 text-yellow-400' : 'text-slate-300'} />
          </button>
        ))}
      </div>
    );

    // Inline Status Select
    const InlineStatus = ({ book }) => (
      <select value={book.status} 
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { e.stopPropagation(); saveBookToCloud({...book, status: e.target.value}); }}
        className="text-[10px] font-bold bg-slate-100 border border-slate-200 rounded px-1 py-0.5 cursor-pointer outline-none">
        <option value="TO_READ">Da Leggere</option>
        <option value="READING">In Lettura</option>
        <option value="READ">Già Letto</option>
      </select>
    );

    // DaScaricare Toggle
    const DaScaricareBadge = ({ book }) => (
      <button onClick={(e) => { e.stopPropagation(); saveBookToCloud({...book, daScaricare: !book.daScaricare}); }}
        title={book.daScaricare ? "Rimuovi flag Da Scaricare" : "Segna come Da Scaricare"}
        className={`text-[10px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition-colors ${book.daScaricare ? 'bg-emerald-100 text-emerald-700 border border-emerald-300' : 'bg-slate-50 text-slate-400 border border-slate-200 hover:bg-slate-100'}`}>
        📥 {book.daScaricare ? 'Sì' : 'No'}
      </button>
    );

    // Interruttore "In Coda": determina chi compare nella sezione Da Leggere
    const InCodaBadge = ({ book }) => (
      <button onClick={(e) => { e.stopPropagation(); saveBookToCloud({...book, isNextRead: !book.isNextRead}); }}
        title={book.isNextRead ? "Togli dalla coda di lettura" : "Metti in coda di lettura"}
        className={`text-[10px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition-colors ${book.isNextRead ? 'bg-purple-100 text-purple-700 border border-purple-300' : 'bg-slate-50 text-slate-400 border border-slate-200 hover:bg-slate-100'}`}>
        🔖 {book.isNextRead ? 'In Coda' : 'Coda'}
      </button>
    );

    // Riga libro riutilizzabile. group = gruppo di appartenenza (serve per i
    // limiti dello spostamento su/giù e per il riordino via drag & drop).
    const BookRow = ({ book, sectionKey, group, fullOrder = null, hero = false }) => {
      const idx = group.findIndex(b => b.id === book.id);
      return (
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, book.id, sectionKey)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => handleDropOnBook(e, sectionKey, group, book.id, fullOrder)}
          onClick={() => openBookDetails(book)}
          className={`flex items-center gap-2 p-2 hover:bg-white/70 rounded-lg cursor-grab active:cursor-grabbing transition-colors border border-slate-100 hover:border-slate-300 group ${book.daScaricare ? 'bg-emerald-50/40' : 'bg-white/50'}`}
        >
          <div className={`${hero ? 'w-11 h-16' : 'w-9 h-13'} bg-slate-200 rounded overflow-hidden shrink-0 relative shadow-xs`}>
            {book.coverUrl
              ? <img src={book.coverUrl} className="w-full h-full object-cover" alt="" loading="lazy" />
              : <Book className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-400" size={14} />}
          </div>
          <div className="flex-1 overflow-hidden min-w-0">
            <p className={`${hero ? 'text-sm' : 'text-xs'} font-bold text-slate-800 truncate group-hover:text-blue-600`}>{book.title}</p>
            <p className="text-[10px] text-slate-500 truncate">{book.lastName} {book.firstName}</p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <InlineStars book={book} />
              <InlineStatus book={book} />
              <InCodaBadge book={book} />
              <DaScaricareBadge book={book} />
            </div>
          </div>
          <div className="flex flex-col gap-0.5 shrink-0">
            <button title="Porta in cima alla sezione"
              onClick={(e) => { e.stopPropagation(); portaInCimaSezione(sectionKey, group, book.id, fullOrder); }}
              disabled={idx <= 0}
              className="p-0.5 hover:bg-indigo-100 rounded text-indigo-500 hover:text-indigo-700 disabled:opacity-20 cursor-pointer"><ChevronsUp size={12} /></button>
            <button title="Sposta su"
              onClick={(e) => { e.stopPropagation(); moveInSection(sectionKey, group, book.id, 'up', fullOrder); }}
              disabled={idx <= 0}
              className="p-0.5 hover:bg-blue-100 rounded text-slate-500 hover:text-blue-700 disabled:opacity-20 cursor-pointer"><ChevronUp size={12} /></button>
            <button title="Sposta giù"
              onClick={(e) => { e.stopPropagation(); moveInSection(sectionKey, group, book.id, 'down', fullOrder); }}
              disabled={idx === group.length - 1}
              className="p-0.5 hover:bg-blue-100 rounded text-slate-500 hover:text-blue-700 disabled:opacity-20 cursor-pointer"><ChevronDown size={12} /></button>
          </div>
        </div>
      );
    };

    // Sezione generica riutilizzabile.
    // groups: se la sezione ha più gruppi (Da Leggere), l'ordine manuale e lo
    // spostamento restano confinati dentro ciascun gruppo.
    const DashSection = ({ title, icon: Icon, iconClass, badgeClass, books: sectionBooks,
                           limitKey, dropTarget, emptyMsg, hero = false, groups = null }) => {
      const visibleBooks = sectionBooks.slice(0, limits[limitKey]);
      const hasMore = sectionBooks.length > limits[limitKey];
      const groupList = groups || [sectionBooks];
      const groupOf = (b) => groupList.find(g => g.some(x => x.id === b.id)) || sectionBooks;
      return (
        <Card
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => handleDropOnSection(e, dropTarget)}
          className={`p-4 border-2 border-dashed border-transparent hover:border-slate-300 transition-colors ${hero ? 'bg-gradient-to-br from-blue-50 to-indigo-50 !border-blue-200 shadow-md' : ''}`}
        >
          <div className="flex items-center justify-between mb-3 border-b pb-2 gap-2">
            <h3 className={`font-bold text-slate-800 ${hero ? 'text-base' : 'text-sm'} flex items-center gap-2 min-w-0`}>
              <Icon className={`${iconClass} shrink-0`} size={hero ? 18 : 16} />
              <span className="truncate">{title}</span>
              <span className="text-slate-400 font-semibold shrink-0">({sectionBooks.length})</span>
            </h3>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${badgeClass}`}>Trascina qui</span>
          </div>
          <div className={`space-y-1.5 ${hero ? 'max-h-[420px]' : 'max-h-[560px]'} overflow-y-auto pr-1`}>
            {visibleBooks.length > 0 ? visibleBooks.map(b => (
              <BookRow key={b.id} book={b} sectionKey={dropTarget} group={groupOf(b)}
                fullOrder={groups} hero={hero} />
            )) : <p className="text-xs text-slate-400 italic py-6 text-center">{emptyMsg}</p>}
          </div>
          {hasMore && (
            <button onClick={() => setLimits(prev => ({...prev, [limitKey]: prev[limitKey] + 30}))}
              className="w-full mt-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer transition-colors">
              Mostra altri ({sectionBooks.length - limits[limitKey]} rimanenti)
            </button>
          )}
        </Card>
      );
    };

    // AI Handlers
    const handleConsiglioBibliotecario = async () => {
      setAiModal({ isOpen: true, title: 'Il Consiglio del Bibliotecario AI', content: '', loading: true });
      const lettiTitoli = readBooks.map(b => `${b.title} (${b.lastName})`).slice(0, 10).join(', ');
      const prompt = `Ho letto e apprezzato questi libri: ${lettiTitoli || 'romanzi classici e moderni'}. Basandoti sui miei gusti, consigliami 3 libri con autore e motivazione in italiano.`;
      try {
        const risposta = await handleAiCallWithCheck(prompt, "Sei un bibliotecario colto e appassionato.", true); 
        setAiModal({ isOpen: true, title: 'Il Consiglio del Bibliotecario AI', content: risposta, loading: false });
      } catch (e) {
        setAiModal({ isOpen: true, title: 'Assistente AI', content: e.message || 'Impossibile contattare l\'assistente AI.', loading: false });
      }
    };

    const handleProfiloLettore = async () => {
      setAiModal({ isOpen: true, title: 'Identikit del Lettore AI', content: '', loading: true });
      const lettiTitoli = readBooks.map(b => `${b.title} (${b.lastName})`).join(', ');
      const prompt = `Analizza questa lista di letture dell'utente: ${lettiTitoli || 'Nessun libro inserito ancora.'}. Crea un profilo psicologico e letterario simpatico ed accurato. Assegnagli un archetipo di lettore in italiano (es. "L'Esploratore di Mondi", "L'Analista Notturno").`;
      try {
        const risposta = await handleAiCallWithCheck(prompt, "Sei un critico letterario ironico ed empatico.", false);
        setAiModal({ isOpen: true, title: 'Il Tuo Identikit Letterario AI', content: risposta, loading: false });
      } catch (e) {
        setAiModal({ isOpen: true, title: 'Assistente AI', content: e.message || 'Impossibile generare l\'identikit.', loading: false });
      }
    };

    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Totale Libri" value={total} icon={BookOpen} color="blue" />
          <StatCard label="Letti" value={readCount} icon={CheckCircle} color="green" />
          <StatCard label="Da Leggere" value={toReadCount} icon={Circle} color="amber" />
          <StatCard label="Media Voti (Letti)" value={`${avgRating} ★`} icon={Star} color="purple" />
        </div>

        {/* Versione */}
        <p className="text-[10px] text-slate-400 text-right font-mono">Release v{APP_VERSION}</p>

        {/* AI Buttons */}
        <div className="flex flex-col sm:flex-row gap-4">
          <button onClick={handleConsiglioBibliotecario} className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 text-white px-6 py-4 rounded-xl font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center text-xs cursor-pointer">
            <Wand2 className="mr-2" size={18} /> ✨ Suggeriscimi un Libro con AI
          </button>
          <button onClick={handleProfiloLettore} className="flex-1 bg-gradient-to-r from-pink-500 to-orange-500 text-white px-6 py-4 rounded-xl font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center text-xs cursor-pointer">
            <Sparkles className="mr-2" size={18} /> ✨ Analizza il mio Profilo Lettore
          </button>
        </div>

        {/* Riga superiore: In Lettura e Da Scaricare affiancate */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          <DashSection
            title="📖 In Lettura" icon={BookOpen} iconClass="text-blue-600"
            badgeClass="bg-blue-100 text-blue-800" books={inLetturaBooks}
            limitKey="inLettura" dropTarget="inLettura" hero={true}
            emptyMsg="Nessun libro in lettura. Trascina un libro qui per iniziare!"
          />
          <DashSection
            title="📥 Da Scaricare" icon={UploadCloud} iconClass="text-emerald-600"
            badgeClass="bg-emerald-100 text-emerald-800" books={daScaricareBooks}
            limitKey="daScaricare" dropTarget="daScaricare" hero={true}
            emptyMsg="Nessun libro da scaricare. Segna un libro con 📥, oppure trascinalo qui."
          />
        </div>

        {/* Sezioni 2-4 affiancate */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          <DashSection
            title="⭐ I tuoi Preferiti" icon={Star} iconClass="text-yellow-500 fill-yellow-500"
            badgeClass="bg-yellow-100 text-yellow-800" books={preferitiBooks}
            limitKey="preferiti" dropTarget="preferiti"
            emptyMsg="Nessun libro preferito. Assegna 4 o 5 stelle a un libro!"
          />
          <DashSection
            title="✓ Già Letti" icon={CheckCircle} iconClass="text-emerald-500"
            badgeClass="bg-emerald-100 text-emerald-800" books={giaLettiBooks}
            limitKey="giaLetti" dropTarget="giaLetti"
            emptyMsg="Nessun libro letto. Trascina un libro qui!"
          />
          <DashSection
            title="📚 Da Leggere · In Coda" icon={Circle} iconClass="text-amber-500"
            badgeClass="bg-amber-100 text-amber-800" books={daLeggereBooks}
            groups={daLeggereGroups}
            limitKey="daLeggere" dropTarget="daLeggere"
            emptyMsg="Nessun libro in coda. Segna un libro con 🔖 Coda, oppure trascinalo qui."
          />
        </div>
      </div>
    );
  };


  // 2. Libreria View
  const LibreriaView = () => {
    // Il campo di ricerca aggiorna testoRicerca a ogni tasto, ma il filtro usa
    // searchQ, aggiornato con un ritardo: senza, ogni lettera rifiltrerebbe e
    // ridisegnerebbe migliaia di schede e la digitazione risulterebbe bloccata.
    const [testoRicerca, setTestoRicerca] = useState('');
    const [searchQ, setSearchQ] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [selectedIds, setSelectedIds] = useState([]);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [limiteVisibile, setLimiteVisibile] = useState(60);

    useEffect(() => {
      const t = setTimeout(() => setSearchQ(testoRicerca), 250);
      return () => clearTimeout(t);
    }, [testoRicerca]);

    // Cambiando ricerca o filtro si riparte dall'inizio dell'elenco
    useEffect(() => { setLimiteVisibile(60); }, [searchQ, statusFilter, starFilters]);

    const filtered = books.filter(b => {
      if (!b) return false;
      const title = (b.title || '').toString().toLowerCase();
      const lastName = (b.lastName || '').toString().toLowerCase();
      const firstName = (b.firstName || '').toString().toLowerCase();
      const query = (searchQ || '').toString().trim().toLowerCase();

      const matchSearch = !query || title.includes(query) || lastName.includes(query) || firstName.includes(query) || `${firstName} ${lastName}`.includes(query) || `${lastName} ${firstName}`.includes(query);
      const matchStatus = statusFilter === 'ALL' || b.status === statusFilter;
      // Filtro stelle: si combina con ricerca e stato. Vuoto = tutti.
      const matchStelle = starFilters.length === 0 || starFilters.includes(Number(b.rating) || 0);
      return matchSearch && matchStatus && matchStelle;
    });

    // Ordine predefinito deterministico. Prima i già letti dal più recente,
    // poi in lettura, poi da leggere. A parità, l'id come ultimo criterio:
    // senza, l'ordine dipenderebbe da come Firestore restituisce i documenti,
    // che cambia da un dispositivo all'altro.
    const PESO_STATO = { READ: 0, READING: 1, TO_READ: 2 };
    const ordinati = filtered.slice().sort((a, b) => {
      // L'ultimo libro salvato precede tutto, anche i già letti: dopo averlo
      // salvato deve essere sotto gli occhi, non da cercare.
      if (a.id === ultimoSalvatoId && b.id !== ultimoSalvatoId) return -1;
      if (b.id === ultimoSalvatoId && a.id !== ultimoSalvatoId) return 1;
      const pa = PESO_STATO[a.status] ?? 3;
      const pb = PESO_STATO[b.status] ?? 3;
      if (pa !== pb) return pa - pb;
      const ta = new Date(a.updatedAt || 0).getTime();
      const tb = new Date(b.updatedAt || 0).getTime();
      if (ta !== tb) return tb - ta;
      return String(a.id).localeCompare(String(b.id));
    });

    // L'ordine manuale della libreria ha priorità e viene sincronizzato
    const ordered = applyManualOrder(ordinati, libreriaOrder);
    const visibili = ordered.slice(0, limiteVisibile);

    const toggleSelect = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    const selectAll = () => setSelectedIds(filtered.map(b => b.id));
    const deselectAll = () => setSelectedIds([]);

    const pulisciDuplicati = async () => {
      const visti = new Set();
      const duplicatiDaEliminare = [];
      books.forEach(b => {
        const chiave = `${b.title?.toLowerCase().trim()}-${b.lastName?.toLowerCase().trim()}`;
        if (visti.has(chiave)) {
          duplicatiDaEliminare.push(b.id);
        } else {
          visti.add(chiave);
        }
      });

      if (duplicatiDaEliminare.length === 0) {
        showToast("Nessun duplicato trovato nella tua libreria.", "info");
        return;
      }

      const daEliminare = new Set(duplicatiDaEliminare);
      setBooks(prev => prev.filter(b => !daEliminare.has(b.id)));

      // Senza cancellarli anche da Firestore i duplicati tornavano al primo
      // aggiornamento dal cloud, facendo sembrare la pulizia inefficace.
      if (db && user) {
        setSyncStatus('syncing');
        let eliminati = 0;
        let falliti = 0;
        const elenco = [...daEliminare];
        for (let i = 0; i < elenco.length; i += 200) {
          const blocco = elenco.slice(i, i + 200);
          try {
            const batch = db.batch();
            blocco.forEach(id => batch.delete(db.collection('books').doc(id)));
            await batch.commit();
            eliminati += blocco.length;
          } catch (err) {
            console.error("Errore eliminazione duplicati:", err?.code, err);
            falliti += blocco.length;
          }
        }
        setSyncStatus(falliti > 0 ? 'error' : 'synced');
        showToast(
          falliti > 0
            ? `Rimossi ${eliminati} duplicati, ${falliti} non eliminati dal cloud.`
            : `Pulizia completata. ${eliminati} duplicati rimossi.`,
          falliti > 0 ? 'error' : 'success'
        );
      } else {
        showToast(`Pulizia completata. ${duplicatiDaEliminare.length} duplicati rimossi in locale.`);
      }
    };

    const eseguiEliminazione = async () => {
      if (selectedIds.length === 0) return;
      setBooks(prev => prev.filter(b => !selectedIds.includes(b.id)));
      setSelectedIds([]);
      setConfirmingDelete(false);
      showToast('Libri eliminati con successo.');
    };

    const aggiornaAIMultipla = async () => {
      if (selectedIds.length === 0) return showToast("Seleziona almeno un libro.", "info");
      setAiModal({ isOpen: true, title: 'Aggiornamento Trame AI', content: 'Ricerca e sintesi trame dal web in corso...', loading: true });
      
      const booksToUpdate = books.filter(b => selectedIds.includes(b.id));
      let count = 0;
      let saltati = 0;
      let primoErrore = null;

      for (const b of booksToUpdate) {
        // Chi ha gia' una trama viene saltato: rigenerarla sovrascriverebbe
        // testi scritti a mano.
        if (b.description) { saltati++; continue; }
        try {
          const prompt = `Riassumi in massimo 50 parole la trama del libro "${b.title}" di ${b.lastName}. In italiano.`;
          const trama = await handleAiCallWithCheck(prompt, "", true);
          if (trama) {
            await saveBookToCloud({ ...b, description: trama });
            count++;
          }
        } catch (e) {
          // Prima l'errore veniva ingoiato da un catch vuoto: la funzione
          // sembrava non fare nulla senza dire perche'.
          if (!primoErrore) primoErrore = e;
          console.error("Errore trama AI per", b.title, e);
        }
      }

      setAiModal({ isOpen: false, title: '', content: '', loading: false });
      setSelectedIds([]);

      if (count === 0 && primoErrore) {
        showToast(`Nessuna trama recuperata. ${primoErrore.message || 'Errore AI'}`, "error");
      } else if (count === 0 && saltati > 0) {
        showToast(`I ${saltati} libri selezionati hanno gia' una trama.`, "info");
      } else {
        showToast(
          `Aggiornate le trame di ${count} libri.` + (saltati > 0 ? ` ${saltati} avevano gia' una trama.` : '') +
          (primoErrore ? ` Alcune non recuperate: ${primoErrore.message || 'errore AI'}` : '')
        );
      }
    };

    return (
      <div className="space-y-4 max-w-7xl mx-auto">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col lg:flex-row gap-4 justify-between items-center">
          <div className="relative w-full lg:w-1/3 flex items-center">
            <Search className="absolute left-3 text-slate-400" size={18} />
            <input 
              type="text" placeholder="Cerca per titolo o autore..." value={testoRicerca} onChange={(e) => setTestoRicerca(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </div>
          <div className="flex flex-wrap gap-2 w-full lg:w-auto items-center">
            <button onClick={pulisciDuplicati} className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg flex items-center cursor-pointer"><Layers size={14} className="mr-1"/> Pulisci Duplicati</button>
            <button onClick={selectedIds.length === filtered.length ? deselectAll : selectAll} className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg flex items-center cursor-pointer"><CheckCircle size={14} className="mr-1"/> {selectedIds.length === filtered.length && filtered.length > 0 ? 'Deseleziona' : 'Seleziona Tutti'}</button>
            <button onClick={aggiornaAIMultipla} className="px-3 py-2 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-xs font-bold rounded-lg flex items-center cursor-pointer"><Wand2 size={14} className="mr-1"/> ✨ Trame AI</button>
            
            {confirmingDelete ? (
              <div className="flex items-center bg-red-50 border border-red-200 rounded-lg px-2 py-1 gap-2">
                <span className="text-xs font-bold text-red-700">Confermi?</span>
                <button onClick={eseguiEliminazione} className="text-xs font-black bg-red-600 text-white px-2 py-1 rounded cursor-pointer">SI</button>
                <button onClick={() => setConfirmingDelete(false)} className="text-xs font-black bg-slate-200 text-slate-800 px-2 py-1 rounded cursor-pointer">NO</button>
              </div>
            ) : (
              <button onClick={() => { if (selectedIds.length > 0) setConfirmingDelete(true); else showToast("Seleziona almeno un libro.", "info"); }} className="px-3 py-2 bg-red-100 hover:bg-red-200 text-red-700 text-xs font-bold rounded-lg flex items-center cursor-pointer"><Trash2 size={14} className="mr-1"/> Elimina</button>
            )}
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide items-center">
          {['ALL', 'READ', 'TO_READ', 'READING'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors cursor-pointer ${statusFilter === s ? 'bg-slate-800 text-white shadow-sm' : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
              {s === 'ALL' ? 'Tutti' : s === 'READ' ? 'Letti' : s === 'TO_READ' ? 'Da Leggere' : 'In Lettura'}
            </button>
          ))}
          <button onClick={() => { setSelectedBook(null); setActiveTab('scheda_libro'); }} className="ml-auto px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-full flex items-center shadow-sm whitespace-nowrap cursor-pointer">
            <Plus size={16} className="mr-1"/> Nuovo Libro Manuale
          </button>
        </div>

        {/* Filtro stelle a selezione multipla, sostituisce il vecchio "Valutati" */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide items-center">
          <span className="text-xs font-bold text-slate-500 whitespace-nowrap shrink-0">Stelle:</span>
          {[5, 4, 3, 2, 1, 0].map(v => {
            const attivo = starFilters.includes(v);
            return (
              <button key={v} onClick={() => toggleStarFilter(v)}
                title={v === 0 ? 'Libri senza valutazione' : `Libri con ${v} stelle`}
                className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors cursor-pointer flex items-center gap-1 ${attivo ? 'bg-yellow-400 text-yellow-950 shadow-sm border border-yellow-500' : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                {v === 0 ? 'Senza voto' : <>{v} <Star size={11} className={attivo ? 'fill-yellow-900 text-yellow-900' : 'fill-yellow-400 text-yellow-400'} /></>}
              </button>
            );
          })}
          {starFilters.length > 0 && (
            <button onClick={() => { setStarFilters([]); try { localStorage.setItem('libreria_star_filters', '[]'); } catch(e) {} saveSettingsToCloud({ starFilters: [] }); }}
              className="px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer flex items-center gap-1">
              <X size={12} /> Azzera
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 mt-4">
          {visibili.map((b, idx) => {
            const isReading = b.status === 'READING';
            return (
              <div 
                key={b.id} 
                className={`bg-white rounded-2xl shadow-sm border flex flex-col relative h-[350px] transition-all group ${
                  isReading 
                    ? 'border-2 border-blue-500 ring-4 ring-blue-100/80 bg-blue-50/20 shadow-md shadow-blue-500/10' 
                    : selectedIds.includes(b.id) 
                      ? 'border-blue-500 ring-2 ring-blue-100' 
                      : 'border-slate-200 hover:border-slate-300 hover:shadow-md'
                }`}
              >
                {/* Seleziona Checkbox */}
                <div className="absolute top-2 left-2 z-10">
                  <input type="checkbox" checked={selectedIds.includes(b.id)} onChange={() => toggleSelect(b.id)} className="w-5 h-5 cursor-pointer accent-blue-600 shadow"/>
                </div>

                {/* Pulsanti Spostamento Su / Giù nell'ordine */}
                <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 opacity-90 group-hover:opacity-100 transition-opacity bg-white/90 backdrop-blur-sm p-0.5 rounded-lg shadow-sm border border-slate-200">
                  <button 
                    title="Sposta Su nella lista" 
                    onClick={(e) => { e.stopPropagation(); moveInSection('libreria', ordered, b.id, 'up'); }}
                    disabled={idx === 0}
                    className="p-1 hover:bg-blue-100 text-slate-700 hover:text-blue-700 disabled:opacity-30 rounded transition-colors cursor-pointer"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button 
                    title="Sposta Giù nella lista" 
                    onClick={(e) => { e.stopPropagation(); moveInSection('libreria', ordered, b.id, 'down'); }}
                    disabled={idx === ordered.length - 1}
                    className="p-1 hover:bg-blue-100 text-slate-700 hover:text-blue-700 disabled:opacity-30 rounded transition-colors cursor-pointer"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>

                {/* Badge In Lettura Prominente */}
                {isReading && (
                  <div className="absolute top-2 left-9 z-10 bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-[9px] font-black uppercase px-2 py-0.5 rounded-full shadow flex items-center gap-1 animate-pulse">
                    <span>📖 IN LETTURA</span>
                  </div>
                )}

                <div className="h-48 w-full bg-slate-50 flex-shrink-0 cursor-pointer overflow-hidden border-b border-slate-100 relative rounded-t-2xl" onClick={() => openBookDetails(b)}>
                  {b.coverUrl ? <img src={b.coverUrl} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" alt="Cover" /> : <Book className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-300" size={32}/>}
                </div>
                <div className="p-3 flex flex-col flex-grow">
                  <h3 className="font-bold text-slate-800 text-xs line-clamp-2 leading-tight">{b.title}</h3>
                  <p className="text-[11px] text-slate-500 line-clamp-1 mt-1 font-medium">{b.lastName} {b.firstName}</p>
                  <div className="mt-1 flex text-yellow-400">
                     {[...Array(5)].map((_,i) => <Star key={i} size={11} className={i < (b.rating || 0) ? 'fill-yellow-400 text-yellow-400' : 'text-slate-200'} />)}
                  </div>
                  <div className="mt-auto pt-2 flex justify-between items-center">
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md uppercase border ${STATUSES[b.status]?.color || 'bg-slate-100'}`}>{STATUSES[b.status]?.label}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {ordered.length > limiteVisibile && (
          <div className="mt-6 text-center">
            <p className="text-xs text-slate-500 mb-2">
              Mostrati {visibili.length} di {ordered.length} libri
            </p>
            <button
              onClick={() => setLimiteVisibile(n => n + 60)}
              className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer transition-colors"
            >
              Mostra altri 60
            </button>
          </div>
        )}
      </div>
    );
  };

  // 3. Esplora Online View
  const EsploraOnlineView = ({ mode, results, setResults }) => {
    const [loading, setLoading] = useState(false);
    const [errore, setErrore] = useState('');

    const caricaNovita = async () => {
      setLoading(true);
      setErrore('');
      try {
        const elenco = await fetchNovitaItalia(30);
        if (elenco.length === 0) {
          setErrore("Il servizio non ha restituito risultati. Riprova più tardi.");
        } else {
          setResults(elenco);
          showToast(`${elenco.length} novità caricate dalle classifiche italiane.`);
        }
      } catch (e) {
        console.error("Errore caricamento novità:", e);
        setErrore(e.message || "Impossibile caricare le novità.");
      } finally {
        setLoading(false);
      }
    };

    // Al primo accesso l'elenco si carica da solo: non c'e' motivo di
    // chiedere un clic per dei dati pubblici che non costano nulla.
    useEffect(() => {
      if (results.length === 0) caricaNovita();
    }, []);

    const addDaEsplora = (item) => {
      const info = item.volumeInfo;
      const newBook = {
        title: info.title || '', 
        firstName: '', 
        lastName: info.authors?.[0] || 'Sconosciuto',
        coverUrl: info.imageLinks?.thumbnail || '', 
        status: 'TO_READ', 
        rating: 0,
        isNextRead: false, 
        description: info.description || '', 
        notes: ''
      };
      // Aggiunta da Bestseller/Novità: deve comparire subito in cima
      saveBookToCloud(newBook, { portaInCima: true });
    };

    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Novità Consigliate</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Le uscite più recenti dalle classifiche italiane di Apple Books, aggiornate ogni giorno.
              {results.length > 0 && ` — ${results.length} titoli`}
            </p>
          </div>
          <button onClick={caricaNovita} disabled={loading} className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl font-bold text-xs flex items-center shadow-md w-full sm:w-auto justify-center transition-colors cursor-pointer">
            <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`}/> Aggiorna elenco
          </button>
        </div>

        {errore && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm flex items-start gap-3">
            <X size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-bold mb-0.5">Non è stato possibile caricare le novità</p>
              <p className="text-xs">{errore}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-20"><RefreshCw className="animate-spin mx-auto text-indigo-500 mb-4" size={32}/><p className="text-slate-600 font-medium text-sm">Recupero delle novità dalle classifiche italiane...</p></div>
        ) : results.length === 0 && !errore ? (
          <p className="text-center text-slate-500 text-sm py-20">Nessuna novità disponibile al momento.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-4">
            {results.map((item, idx) => (
              <Card key={idx} className="p-4 flex flex-col h-[290px] justify-between">
                <div>
                  <div className="h-24 w-16 bg-slate-100 rounded shadow-sm flex-shrink-0 relative overflow-hidden mb-3">
                     {item.volumeInfo.imageLinks?.thumbnail ? <img src={item.volumeInfo.imageLinks.thumbnail} className="w-full h-full object-cover" alt="Copertina"/> : <Book className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-300" size={20}/>}
                  </div>
                  <h4 className="font-bold text-slate-900 text-xs line-clamp-2 mb-1">{item.volumeInfo.title}</h4>
                  <p className="text-[11px] text-slate-500 mb-1 font-medium truncate">{item.volumeInfo.authors?.[0]}</p>
                  {item.volumeInfo.publishedDate && (
                    <p className="text-[10px] text-slate-400 mb-2">
                      Uscita: {new Date(item.volumeInfo.publishedDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  )}
                </div>
                <div className="mt-auto pt-2 border-t border-slate-100 flex flex-col gap-2">
                  <button onClick={() => setAiModal({ isOpen:true, title: item.volumeInfo.title, content: item.volumeInfo.description || 'Nessuna trama disponibile.', loading:false })} className="text-[11px] text-blue-600 font-semibold underline text-left cursor-pointer">Leggi Trama</button>
                  <button onClick={() => addDaEsplora(item)} className="w-full bg-slate-100 hover:bg-blue-600 hover:text-white text-blue-700 text-xs font-bold py-2 rounded-lg flex justify-center items-center transition-colors cursor-pointer">
                    <Plus size={14} className="mr-1" /> Aggiungi alla Libreria
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  };

  // 4. Cerca Online View
  const CercaOnlineView = ({ data, setData }) => {
    const [q, setQ] = useState(data.q);
    const [isSearching, setIsSearching] = useState(false);
    
    const cerca = async () => {
      if(!q) return;
      setIsSearching(true);
      try {
        let items = [];
        // 1. iTunes Apple Search API
        try {
          const itRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=ebook&country=it&limit=15`);
          if (itRes.ok) {
            const resultData = await itRes.json();
            items = (resultData.results || []).map(item => {
              const tempDiv = document.createElement("div");
              tempDiv.innerHTML = item.description || "";
              const cleanDesc = tempDiv.textContent || tempDiv.innerText || "";
              return {
                 volumeInfo: {
                   title: item.trackName || "Senza Titolo",
                   authors: [item.artistName || "Sconosciuto"],
                   imageLinks: item.artworkUrl100 ? { thumbnail: item.artworkUrl100.replace('100x100bb', '600x600bb') } : null,
                   description: cleanDesc
                 }
              };
            });
          }
        } catch (err) {}

        // 2. Google Books Fallback
        if (items.length === 0) {
          const gRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&langRestrict=it`);
          if (gRes.ok) {
            const resData = await gRes.json();
            items = resData.items || [];
          }
        }
        
        setData({ q, items });
        if(items.length === 0) showToast("Nessun libro trovato per questa ricerca.", "info");
      } catch(e) {
        showToast("Errore di connessione durante la ricerca.", "error");
      } finally {
        setIsSearching(false);
      }
    };

    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <Card className="p-6">
          <label className="font-bold text-slate-800 mb-3 block text-base">Cerca per titolo, autore o ISBN nel Web</label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input type="text" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter' && cerca()} placeholder="Es. Umberto Eco, Il nome della rosa..." className="flex-1 border border-slate-300 p-3 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
            <Button onClick={cerca} disabled={isSearching} loading={isSearching} className="px-8 py-3">
              Cerca Online
            </Button>
          </div>
        </Card>
        
        <div className="space-y-3">
          {data.items.map((item, idx) => (
             <Card key={idx} className="p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-16 bg-slate-100 rounded shadow-sm flex-shrink-0 relative overflow-hidden">
                     {item.volumeInfo.imageLinks?.thumbnail ? <img src={item.volumeInfo.imageLinks.thumbnail} className="w-full h-full object-cover" alt="Copertina"/> : <Book className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-300" size={16}/>}
                  </div>
                  <div>
                    <p className="font-bold text-slate-900 text-sm">{item.volumeInfo.title}</p>
                    <p className="text-xs text-slate-500 font-medium">{item.volumeInfo.authors?.join(', ')}</p>
                  </div>
                </div>
                <button onClick={() => {
                  setSelectedBook({ 
                    title: item.volumeInfo.title, 
                    lastName: item.volumeInfo.authors?.[0] || '', 
                    coverUrl: item.volumeInfo.imageLinks?.thumbnail || '', 
                    description: item.volumeInfo.description || '', 
                    status: 'TO_READ', 
                    rating: 0, 
                    isNextRead: false, 
                    notes: '' 
                  });
                  setActiveTab('scheda_libro');
                }} className="w-full sm:w-auto bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white px-5 py-2 rounded-xl font-bold text-xs transition-colors shadow-sm cursor-pointer">
                   Modifica & Aggiungi
                </button>
             </Card>
          ))}
        </div>
      </div>
    );
  };

  // 5. Import Backup View
  const ImportBackupView = () => {
    const handleExportBackup = () => {
      try {
        const dataStr = JSON.stringify(books, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', url);
        linkElement.setAttribute('download', `backup_libreria_${new Date().toLocaleDateString('it-IT').replace(/\//g, '_')}.json`);
        document.body.appendChild(linkElement);
        linkElement.click();
        document.body.removeChild(linkElement);
        URL.revokeObjectURL(url);
        showToast('Backup scaricato con successo!');
      } catch (err) {
        showToast('Errore durante l\'esportazione.', 'error');
      }
    };

    const handleImportBackup = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;

      let testo;
      try {
        testo = await file.text();
      } catch (err) {
        showToast("Impossibile leggere il file selezionato.", "error");
        return;
      }

      let dati;
      try {
        dati = JSON.parse(testo);
      } catch (err) {
        showToast("Il file non e' un JSON valido.", "error");
        return;
      }

      // Accetta sia l'elenco diretto sia un oggetto che lo contiene
      const lista = Array.isArray(dati)
        ? dati
        : (Array.isArray(dati?.books) ? dati.books : null);
      if (!lista) {
        showToast("Formato non riconosciuto: atteso un elenco di libri.", "error");
        return;
      }

      const uid = user ? user.uid : 'local-user';
      const libri = lista
        .filter(b => b && typeof b === 'object' && (b.title || b.id))
        .map(b => normalizeBook(b, uid, { preservaData: true }));

      if (libri.length === 0) {
        showToast("Nessun libro valido trovato nel file.", "error");
        return;
      }

      // Un solo aggiornamento di stato: con migliaia di libri, salvarli uno a
      // uno provocherebbe altrettanti render dell'intera lista e bloccherebbe
      // il browser.
      setBooks(prev => mergeBooksLists(prev, libri));

      if (!db || !user) {
        showToast(`Importati ${libri.length} libri in locale. Accedi al cloud per sincronizzarli.`, "info");
        return;
      }

      setImportProgress({ fatti: 0, totale: libri.length });
      setSyncStatus('syncing');
      const { salvati, falliti, primoErrore } = await caricaLibriInBlocchi(libri, {
        onProgresso: (fatti, totale) => setImportProgress({ fatti, totale })
      });
      setImportProgress(null);
      setSyncStatus(falliti > 0 ? 'error' : 'synced');

      if (falliti > 0) {
        // Mostrare il codice d'errore di Firestore: senza, l'utente non ha modo
        // di distinguere un problema di permessi da uno di rete.
        const codice = primoErrore?.code || 'sconosciuto';
        const dettaglio = primoErrore?.message ? ` — ${primoErrore.message}` : '';
        showToast(
          `Importati ${salvati} libri su ${libri.length}. Errore cloud [${codice}]${dettaglio}`,
          "error"
        );
      } else {
        showToast(`Importati e sincronizzati ${salvati} libri.`);
      }
    };

    const handleCsvImport = (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const lines = ev.target.result.split('\n');
          let count = 0;
          for (const line of lines.slice(1)) {
            if (!line.trim()) continue;
            const [cognome, nome, titolo, isbn] = line.split(',');
            await saveBookToCloud({
              title: titolo?.trim() || 'Senza Titolo',
              firstName: nome?.trim() || '',
              lastName: cognome?.trim() || 'Sconosciuto',
              status: 'TO_READ',
              rating: 0,
              notes: `ISBN: ${isbn?.trim() || ''}`
            });
            count++;
          }
          showToast(`Importati ${count} libri da CSV!`);
        } catch(err) {
          showToast('Errore durante la lettura del CSV.', 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    };

    return (
      <div className="max-w-3xl mx-auto bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-slate-200 space-y-8">
        <div>
          <h2 className="text-xl font-bold border-b border-slate-100 pb-3 mb-3 text-slate-900">1. Scarica Backup (JSON)</h2>
          <p className="text-slate-500 text-xs mb-4">Salva l'intera collezione in un file JSON sicuro per conservare una copia locale dei tuoi dati.</p>
          <Button onClick={handleExportBackup} icon={Download} className="w-full sm:w-auto py-3">Scaricare File Backup</Button>
        </div>
        <div>
          <h2 className="text-xl font-bold border-b border-slate-100 pb-3 mb-3 text-slate-900">2. Ripristina da Backup (JSON)</h2>
          <p className="text-slate-500 text-xs mb-4">Carica un file JSON generato in precedenza per memorizzarlo direttamente nel tuo browser.</p>
          <label className="inline-block w-full sm:w-auto cursor-pointer">
             <span className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold text-xs cursor-pointer flex items-center justify-center shadow-sm">
                <Upload size={16} className="mr-2" /> Carica File Backup JSON
             </span>
             <input type="file" accept=".json" onChange={handleImportBackup} style={{ display: 'none' }}
               disabled={!!importProgress} />
          </label>

          {importProgress && (
            <div className="mt-4 bg-indigo-50 border border-indigo-200 rounded-xl p-4">
              <div className="flex items-center justify-between text-xs font-bold text-indigo-900 mb-2">
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Importazione in corso — non chiudere questa pagina
                </span>
                <span>{importProgress.fatti} / {importProgress.totale}</span>
              </div>
              <div className="w-full h-2 bg-indigo-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-600 transition-all duration-300"
                  style={{ width: `${Math.round((importProgress.fatti / importProgress.totale) * 100)}%` }} />
              </div>
            </div>
          )}
        </div>
        <div>
          <h2 className="text-xl font-bold border-b border-slate-100 pb-3 mb-3 text-slate-900">3. Importa da File CSV</h2>
          <p className="text-slate-500 text-xs mb-4">Formato colonne richiesto: <code>cognome, nome, titolo, isbn</code></p>
          <label className="inline-block w-full sm:w-auto cursor-pointer">
             <span className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-xl font-bold text-xs cursor-pointer flex items-center justify-center shadow-sm">
                <FileSpreadsheet size={16} className="mr-2" /> Carica File CSV
             </span>
             <input type="file" accept=".csv" onChange={handleCsvImport} style={{ display: 'none' }}/>
          </label>
        </div>
      </div>
    );
  };

  // 6. Scheda Libro (Book Details & Editing View - Complete Repair)
  const SchedaLibro = () => {
    const [isDraggingCover, setIsDraggingCover] = useState(false);

    const [form, setForm] = useState(() => ({
      id: selectedBook?.id || '',
      title: selectedBook?.title || '',
      firstName: selectedBook?.firstName || '',
      lastName: selectedBook?.lastName || '',
      coverUrl: selectedBook?.coverUrl || '',
      status: selectedBook?.status || 'TO_READ',
      rating: Number(selectedBook?.rating) || 0,
      isNextRead: !!selectedBook?.isNextRead,
      description: selectedBook?.description || '',
      notes: selectedBook?.notes || ''
    }));

    useEffect(() => {
      if (selectedBook) {
        setForm({
          id: selectedBook.id || '',
          title: selectedBook.title || '',
          firstName: selectedBook.firstName || '',
          lastName: selectedBook.lastName || '',
          coverUrl: selectedBook.coverUrl || '',
          status: selectedBook.status || 'TO_READ',
          rating: Number(selectedBook.rating) || 0,
          isNextRead: !!selectedBook.isNextRead,
          description: selectedBook.description || '',
          notes: selectedBook.notes || ''
        });
      }
    }, [selectedBook]);

    const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

    const esploraCuriosita = async () => {
      if(!form.title) return showToast("Inserisci un titolo per analizzare le curiosità.", "info");
      setAiModal({ isOpen: true, title: 'Curiosità e Temi AI', content: 'Ricerca aneddoti e temi principali...', loading: true });
      try {
        const info = await handleAiCallWithCheck(`Trova 3 curiosità affascinanti e i 3 temi principali del libro "${form.title}" di ${form.lastName || form.firstName}. In italiano.`, "Sei un critico letterario esperto.", true); 
        setAiModal({ isOpen: true, title: `Curiosità: ${form.title}`, content: info, loading: false });
      } catch(e) { 
        setAiModal({ isOpen: false, title:'', content:'', loading: false }); 
        showToast(e.message || "Errore durante la ricerca.", "error"); 
      }
    };

    const generaRecensioneSocial = async () => {
      if(!form.title) return showToast("Inserisci un titolo.", "info");
      setAiModal({ isOpen: true, title: 'Generatore Post Social AI', content: 'Inoltro richiesta all\'AI...', loading: true });
      try {
        const info = await handleAiCallWithCheck(`Scrivi un post accattivante per Instagram per recensire il libro "${form.title}" di ${form.lastName || form.firstName}. Valutazione: ${form.rating}/5 stelle. Note dell'utente: "${form.notes || 'Ottima lettura'}". In italiano.`); 
        setAiModal({ isOpen: true, title: 'Ecco il tuo Post Instagram!', content: info, loading: false });
      } catch(e) { 
        setAiModal({ isOpen: false, title:'', content:'', loading: false }); 
        showToast(e.message || "Errore durante la generazione.", "error"); 
      }
    };

    const cercaInfoWeb = async () => {
      if(!form.title) return showToast("Inserisci un titolo.", "info");
      setAiModal({ isOpen: true, title: 'Ricerca Info Web AI', content: 'Ricerca trama e copertina sul web...', loading: true });
      try {
        const info = await handleAiCallWithCheck(`Cerca sul web la trama del libro "${form.title}" di ${form.lastName || form.firstName}. Riassumi in 3 paragrafi. In italiano.`, "", true);

        // La copertina va cercata sempre: il pulsante si chiama "Cerca
        // Trama/Cover", quindi saltarla quando ne esiste gia' una faceva
        // sembrare la ricerca rotta. Se non si trova nulla si tiene quella
        // attuale invece di cancellarla.
        const coverTrovata = await secureCoverFetch(form.title, form.lastName || form.firstName);
        const newCoverUrl = coverTrovata || form.coverUrl;

        setForm(prev => ({ ...prev, description: info, coverUrl: newCoverUrl }));
        setAiModal({ isOpen: false, title:'', content:'', loading: false });
        // Messaggio veritiero: prima diceva "recuperate" anche senza copertina
        showToast(
          coverTrovata ? "Trama e copertina recuperate!" : "Trama recuperata. Nessuna copertina trovata sul web.",
          coverTrovata ? "success" : "info"
        );
      } catch(e) { 
        setAiModal({ isOpen: false, title:'', content:'', loading: false }); 
        showToast(e.message || "Errore durante la ricerca sul Web.", "error"); 
      }
    };

    const handleSalva = () => {
      if(!form.title.trim()) return showToast("Il titolo è obbligatorio!", "error");
      // Salvataggio esplicito dalla scheda (anche per i libri trovati con
      // Cerca Web, che passano di qui): il libro va portato in cima
      saveBookToCloud(form, { portaInCima: true });
      navigateTo('libreria');
    };

    const handleElimina = () => {
      if(form.id) {
        deleteBookFromCloud(form.id);
      }
      navigateTo('libreria');
    };

    const processAndSetCover = (rawUrl) => {
      if (!rawUrl) return;
      if (rawUrl.startsWith('data:image/')) {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxW = 500;
          let w = img.width;
          let h = img.height;
          if (w > maxW) {
            h = Math.round((h * maxW) / w);
            w = maxW;
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const compressed = canvas.toDataURL('image/jpeg', 0.85);
          updateField('coverUrl', compressed);
          showToast("Copertina salvata ed ottimizzata!", "success");
        };
        img.onerror = () => {
          updateField('coverUrl', rawUrl);
          showToast("Copertina aggiornata!", "success");
        };
        img.src = rawUrl;
      } else {
        updateField('coverUrl', rawUrl.trim());
        showToast("Copertina aggiornata dall'URL!", "success");
      }
    };

    const handleCoverDrop = (e) => {
      e.preventDefault();
      setIsDraggingCover(false);
      
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = (event) => {
            processAndSetCover(event.target.result);
          };
          reader.readAsDataURL(file);
          return;
        }
      }

      const droppedUrl = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('URL') || e.dataTransfer.getData('text/plain');
      if (droppedUrl && (droppedUrl.startsWith('http://') || droppedUrl.startsWith('https://') || droppedUrl.startsWith('data:image/'))) {
        processAndSetCover(droppedUrl.trim());
      } else {
        showToast("Trascina un file immagine o un'immagine dal browser.", "info");
      }
    };

    const handleCoverFileInput = (e) => {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = (event) => {
          processAndSetCover(event.target.result);
        };
        reader.readAsDataURL(file);
      }
    };

    return (
      <div className="max-w-5xl mx-auto bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden flex flex-col md:flex-row">
        {/* Colonna Sinistra: Copertina con Drag & Drop */}
        <div className="w-full md:w-1/3 bg-slate-50 p-6 flex flex-col items-center border-r border-slate-200">
          <div 
            onDragOver={(e) => { e.preventDefault(); setIsDraggingCover(true); }}
            onDragLeave={() => setIsDraggingCover(false)}
            onDrop={handleCoverDrop}
            className={`w-full max-w-[220px] aspect-[2/3] rounded-xl shadow border-2 overflow-hidden relative mb-4 flex flex-col items-center justify-center transition-all group cursor-pointer ${
              isDraggingCover 
                ? 'border-blue-500 bg-blue-100/50 scale-105 ring-4 ring-blue-300' 
                : form.coverUrl 
                  ? 'border-slate-300 bg-slate-200 hover:border-blue-400' 
                  : 'border-dashed border-slate-300 bg-slate-100 hover:border-blue-400'
            }`}
          >
             {form.coverUrl ? (
               <img src={form.coverUrl} className="w-full h-full object-cover" alt="Copertina" />
             ) : (
               <div className="text-center p-4">
                 <UploadCloud className="mx-auto text-slate-400 mb-2 group-hover:scale-110 transition-transform" size={40} />
                 <p className="text-xs font-bold text-slate-600">Trascina qui l'immagine della copertina</p>
                 <p className="text-[10px] text-slate-400 mt-1">da computer o browser</p>
               </div>
             )}

             {/* Overlay d'aiuto Drag & Drop al mouse over */}
             <div className={`absolute inset-0 bg-blue-900/70 text-white backdrop-blur-xs flex flex-col items-center justify-center p-3 text-center transition-opacity ${isDraggingCover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
               <UploadCloud size={32} className="mb-1 animate-bounce" />
               <span className="text-xs font-black">Rilascia l'immagine</span>
               <span className="text-[10px] opacity-80 mt-0.5">per salvarla come copertina</span>
             </div>
          </div>

          <div className="w-full space-y-2">
            <label className="inline-block w-full cursor-pointer">
              <span className="w-full text-xs font-bold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 py-2.5 px-3 rounded-lg flex items-center justify-center gap-2 shadow-xs transition-colors cursor-pointer">
                <ImageIcon size={15} /> Scegli Immagine da Computer
              </span>
              <input type="file" accept="image/*" onChange={handleCoverFileInput} className="hidden" />
            </label>

            <div>
              <label className="text-[10px] font-bold text-slate-500 uppercase">Oppure incolla URL Copertina</label>
              <input type="text" placeholder="https://..." value={form.coverUrl} onChange={e=>updateField('coverUrl', e.target.value)} className="w-full text-xs p-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 bg-white mt-1" />
            </div>

            <button onClick={async () => {
              if(!form.title) return showToast("Inserisci un titolo prima.", "info");
              const cover = await secureCoverFetch(form.title, form.lastName || form.firstName);
              if(cover) { updateField('coverUrl', cover); showToast("Copertina trovata!"); }
              else showToast("Nessuna copertina trovata sul web.", "info");
            }} className="w-full text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 py-2 rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-1">
              🔍 Cerca Copertina HD sul Web
            </button>
          </div>
        </div>

        {/* Colonna Destra: Campi Form */}
        <div className="w-full md:w-2/3 p-6 sm:p-8 space-y-5">
          <div className="flex justify-between items-center border-b pb-3 border-slate-100">
             <button onClick={() => navigateTo('libreria')} className="text-slate-500 hover:text-slate-800 text-xs font-bold flex items-center cursor-pointer">
               <ArrowLeft size={16} className="mr-1" /> Torna alla Libreria
             </button>
             <span className="text-xs font-semibold text-slate-400">ID: {form.id || 'Nuovo'}</span>
          </div>

          <div>
             <label className="text-xs font-bold text-slate-500 uppercase">Titolo Libro *</label>
             <input type="text" placeholder="Es. Il nome della rosa" value={form.title} onChange={e=>updateField('title', e.target.value)} className="w-full text-xl font-black border-b-2 border-slate-200 focus:border-blue-500 outline-none pb-1 text-slate-900 bg-transparent" />
          </div>
          
          <div className="flex gap-4">
            <div className="w-1/2">
               <label className="text-xs font-bold text-slate-500 uppercase">Nome Autore</label>
               <input type="text" placeholder="Nome" value={form.firstName} onChange={e=>updateField('firstName', e.target.value)} className="w-full text-sm text-slate-700 border-b-2 border-slate-200 focus:border-blue-500 outline-none pb-1 bg-transparent" />
            </div>
            <div className="w-1/2">
               <label className="text-xs font-bold text-slate-500 uppercase">Cognome Autore *</label>
               <input type="text" placeholder="Cognome" value={form.lastName} onChange={e=>updateField('lastName', e.target.value)} className="w-full text-sm text-slate-900 font-bold border-b-2 border-slate-200 focus:border-blue-500 outline-none pb-1 bg-transparent" />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200 w-full sm:w-auto">
               <span className="text-xs font-bold text-slate-700">Valutazione:</span>
               <div className="flex items-center">
                  {[1,2,3,4,5].map(i => <Star key={i} onClick={()=>updateField('rating', i)} size={20} className={`cursor-pointer transition-colors ${i <= form.rating ? 'fill-yellow-400 text-yellow-400' : 'text-slate-300'}`} />)}
                  <button onClick={()=>updateField('rating', 0)} className="ml-3 text-xs font-bold text-red-500 hover:underline cursor-pointer">Azzera</button>
               </div>
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
               <select value={form.status} onChange={e=>updateField('status', e.target.value)} className="p-2.5 border border-slate-300 rounded-xl font-bold text-xs bg-white text-slate-800 outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer">
                  <option value="TO_READ">Da Leggere</option>
                  <option value="READING">In Lettura</option>
                  <option value="READ">Letto</option>
               </select>
               <label className="flex items-center gap-2 cursor-pointer bg-purple-50 px-3 py-2.5 rounded-xl border border-purple-200">
                 <input type="checkbox" checked={form.isNextRead} onChange={e=>updateField('isNextRead', e.target.checked)} className="w-4 h-4 accent-purple-600" />
                 <span className="text-xs font-bold text-purple-900">In Coda</span>
               </label>
            </div>
          </div>

          <div className="bg-indigo-50/60 p-4 rounded-xl border border-indigo-100 space-y-2">
             <h3 className="text-xs font-bold text-indigo-900 flex items-center"><Wand2 size={15} className="mr-1.5"/> Strumenti AI Gemini</h3>
             <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button onClick={cercaInfoWeb} className="bg-white hover:bg-indigo-600 text-indigo-700 hover:text-white px-3 py-2 rounded-lg text-xs font-bold shadow-sm border border-indigo-200 transition-colors cursor-pointer">✨ Cerca Trama/Cover</button>
                <button onClick={esploraCuriosita} className="bg-white hover:bg-purple-600 text-purple-700 hover:text-white px-3 py-2 rounded-lg text-xs font-bold shadow-sm border border-purple-200 transition-colors cursor-pointer">✨ Curiosità & Temi</button>
                <button onClick={generaRecensioneSocial} className="bg-white hover:bg-pink-600 text-pink-700 hover:text-white px-3 py-2 rounded-lg text-xs font-bold shadow-sm border border-pink-200 transition-colors cursor-pointer">✨ Post Instagram</button>
             </div>
          </div>

          <div>
            <label className="text-xs font-bold text-slate-500 uppercase">Trama / Sintesi</label>
            <textarea rows={4} value={form.description} onChange={e=>updateField('description', e.target.value)} placeholder="Descrizione o trama del libro..." className="w-full text-xs p-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 mt-1" />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-500 uppercase">Note Personali</label>
            <textarea rows={2} value={form.notes} onChange={e=>updateField('notes', e.target.value)} placeholder="Note personali, citazioni o pensiero del lettore..." className="w-full text-xs p-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 mt-1" />
          </div>

          <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row justify-between items-center gap-3">
             {form.id && (
               <Button onClick={handleElimina} variant="danger" icon={Trash2}>Elimina Libro</Button>
             )}
             <div className="flex gap-2 w-full sm:w-auto ml-auto">
               <Button onClick={() => navigateTo('libreria')} variant="outline">Annulla</Button>
               <Button onClick={handleSalva} variant="primary" icon={CheckCircle}>Salva Libro</Button>
             </div>
          </div>
        </div>
      </div>
    );
  };

  // 7. Settings Modal (Gemini API Key management)
  const SettingsModal = () => {
    const [tempKey, setTempKey] = useState(apiKey);

    if (!isSettingsOpen) return null;

    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4 border border-slate-200">
          <div className="flex justify-between items-center border-b pb-3">
            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
              <Key size={18} className="text-indigo-600" /> Configurazione AI Gemini
            </h3>
            <button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-slate-600">
              <X size={20} />
            </button>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Per abilitare le funzioni intelligenti (consigli personalizzati, profilo lettore, ricerca trame e post social), inserisci la tua chiave API Google Gemini gratuita.
          </p>

          <div>
            <label className="text-xs font-bold text-slate-700 uppercase block mb-1">Chiave API Gemini</label>
            <input 
              type="password" 
              value={tempKey} 
              onChange={e => setTempKey(e.target.value)}
              placeholder="AIzaSy..." 
              className="w-full p-3 border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
            />
          </div>

          <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-[11px] text-slate-500">
            💡 Puoi ottenere la tua API Key gratuita direttamente da <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-indigo-600 font-bold underline">Google AI Studio</a>. La chiave viene memorizzata esclusivamente nel tuo browser.
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <Button onClick={() => setIsSettingsOpen(false)} variant="outline">Annulla</Button>
            <Button onClick={() => handleSaveApiKey(tempKey)} variant="primary">Salva Chiave</Button>
          </div>
        </div>
      </div>
    );
  };

  // 7b. Auth Modal (Firebase Login / Register and Advanced Configuration)
  const AuthModal = () => {
    const [isRegister, setIsRegister] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    
    // Local state for advanced config overrides
    const [localApiKey, setLocalApiKey] = useState(fbApiKey);
    const [localProjectId, setLocalProjectId] = useState(fbProjectId);
    const [localAuthDomain, setLocalAuthDomain] = useState(fbAuthDomain);
    const [localAppId, setLocalAppId] = useState(fbAppId);

    if (!isAuthModalOpen) return null;

    const handleSubmit = async (e) => {
      e.preventDefault();
      if (!auth) {
        showToast("Firebase non è inizializzato. Controlla la configurazione.", "error");
        return;
      }
      if (!email || !password) {
        setErrorMsg("Compila tutti i campi!");
        return;
      }

      setLoading(true);
      setErrorMsg('');
      try {
        if (isRegister) {
          await auth.createUserWithEmailAndPassword(email, password);
          showToast("Registrazione completata con successo!");
        } else {
          await auth.signInWithEmailAndPassword(email, password);
          showToast("Accesso effettuato con successo!");
        }
        setIsAuthModalOpen(false);
      } catch (err) {
        console.error("Auth error:", err);
        let msg = err.message;
        if (err.code === 'auth/wrong-password') msg = "Password errata.";
        else if (err.code === 'auth/user-not-found') msg = "Utente non trovato.";
        else if (err.code === 'auth/email-already-in-use') msg = "Questo indirizzo email è già registrato.";
        else if (err.code === 'auth/weak-password') msg = "La password deve contenere almeno 6 caratteri.";
        setErrorMsg(msg);
      } finally {
        setLoading(false);
      }
    };

    const handleSaveConfig = () => {
      localStorage.setItem('fb_apiKey', localApiKey.trim());
      localStorage.setItem('fb_projectId', localProjectId.trim());
      localStorage.setItem('fb_authDomain', localAuthDomain.trim());
      localStorage.setItem('fb_appId', localAppId.trim());
      
      setFbApiKey(localApiKey.trim());
      setFbProjectId(localProjectId.trim());
      setFbAuthDomain(localAuthDomain.trim());
      setFbAppId(localAppId.trim());
      
      showToast("Configurazione Firebase salvata! Ricarica per applicare.", "info");
    };

    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4 border border-slate-200 overflow-y-auto max-h-[90vh]">
          <div className="flex justify-between items-center border-b pb-3">
            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
              <UploadCloud size={18} className="text-blue-600" /> 
              {isRegister ? 'Registrati su Libri Cloud' : 'Accedi a Libri Cloud'}
            </h3>
            <button onClick={() => setIsAuthModalOpen(false)} className="text-slate-400 hover:text-slate-600 cursor-pointer">
              <X size={20} />
            </button>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            Accedi per sincronizzare automaticamente i tuoi libri, le note, le valutazioni in stelle e l'ordine di lettura su tutti i tuoi dispositivi.
          </p>

          {errorMsg && (
            <div className="bg-red-50 text-red-700 p-3 rounded-xl text-xs font-semibold border border-red-200">
              ⚠️ {errorMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-[11px] font-bold text-slate-700 uppercase block mb-1">Indirizzo Email</label>
              <input 
                type="email" 
                value={email} 
                onChange={e => setEmail(e.target.value)}
                placeholder="maurizio@example.com" 
                className="w-full p-2.5 border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-700 uppercase block mb-1">Password</label>
              <input 
                type="password" 
                value={password} 
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••" 
                className="w-full p-2.5 border border-slate-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <Button onClick={handleSubmit} loading={loading} className="w-full py-2.5 mt-2">
              {isRegister ? 'Crea Account' : 'Accedi'}
            </Button>
          </form>

          <div className="text-center text-xs">
            <button 
              onClick={() => { setIsRegister(!isRegister); setErrorMsg(''); }}
              className="text-blue-600 hover:underline font-bold cursor-pointer"
            >
              {isRegister ? 'Hai già un account? Accedi' : 'Non hai un account? Registrati'}
            </button>
          </div>

          <div className="border-t pt-3">
            <button 
              onClick={() => setShowAdvanced(!showAdvanced)} 
              className="text-xs font-bold text-slate-600 hover:text-slate-900 flex items-center justify-between w-full cursor-pointer"
            >
              <span>⚙️ Opzioni Database Firebase Avanzate</span>
              <span>{showAdvanced ? '▲' : '▼'}</span>
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-2.5 bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
                <p className="text-[10px] text-slate-500 mb-2">
                  Inserisci le credenziali del tuo database Firebase personale per memorizzare i dati nel tuo cloud privato.
                </p>
                <div>
                  <label className="text-[9px] font-bold text-slate-600 block mb-0.5">Firebase API Key</label>
                  <input type="password" value={localApiKey} onChange={e=>setLocalApiKey(e.target.value)} placeholder="AIzaSy..." className="w-full p-1.5 border border-slate-300 rounded text-xs" />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-slate-600 block mb-0.5">Project ID</label>
                  <input type="text" value={localProjectId} onChange={e=>setLocalProjectId(e.target.value)} placeholder="my-project-123" className="w-full p-1.5 border border-slate-300 rounded text-xs" />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-slate-600 block mb-0.5">Auth Domain</label>
                  <input type="text" value={localAuthDomain} onChange={e=>setLocalAuthDomain(e.target.value)} placeholder="my-project-123.firebaseapp.com" className="w-full p-1.5 border border-slate-300 rounded text-xs" />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-slate-600 block mb-0.5">App ID</label>
                  <input type="text" value={localAppId} onChange={e=>setLocalAppId(e.target.value)} placeholder="1:123456789:web:123" className="w-full p-1.5 border border-slate-300 rounded text-xs" />
                </div>
                <button 
                  onClick={handleSaveConfig}
                  className="w-full py-1.5 bg-slate-800 text-white font-bold rounded text-xs hover:bg-slate-900 cursor-pointer"
                >
                  Salva Configurazione Privata
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // 8. Reusable AI Response Modal
  const AiModalView = () => {
    const [copied, setCopied] = useState(false);

    if (!aiModal.isOpen) return null;

    const copyToClipboard = () => {
      navigator.clipboard.writeText(aiModal.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-xl space-y-4 border border-slate-200 max-h-[85vh] flex flex-col">
          <div className="flex justify-between items-center border-b pb-3">
            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
              <Sparkles size={18} className="text-indigo-600" /> {aiModal.title}
            </h3>
            <button onClick={() => setAiModal({ isOpen: false, title: '', content: '', loading: false })} className="text-slate-400 hover:text-slate-600">
              <X size={20} />
            </button>
          </div>

          {aiModal.loading ? (
            <div className="py-12 text-center space-y-3">
              <RefreshCw className="animate-spin mx-auto text-indigo-600" size={32} />
              <p className="text-sm font-medium text-slate-600">L'assistente AI sta elaborando la tua richiesta...</p>
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto text-xs text-slate-700 leading-relaxed whitespace-pre-wrap font-sans bg-slate-50 p-4 rounded-xl border border-slate-200">
                {aiModal.content}
              </div>
              <div className="flex justify-between items-center pt-2">
                <button onClick={copyToClipboard} className="text-xs font-bold text-slate-600 hover:text-indigo-600 flex items-center gap-1 cursor-pointer">
                  {copied ? <CheckCircle size={14} className="text-emerald-500" /> : <Copy size={14} />}
                  {copied ? 'Copiato!' : 'Copia Testo'}
                </button>
                <Button onClick={() => setAiModal({ isOpen: false, title: '', content: '', loading: false })} variant="secondary">
                  Chiudi
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-5 right-5 z-50 px-5 py-3 rounded-xl shadow-lg font-bold text-xs text-white flex items-center gap-2 transition-all ${toast.type === 'error' ? 'bg-red-600' : toast.type === 'info' ? 'bg-slate-800' : 'bg-emerald-600'}`}>
          <CheckCircle size={16} />
          {toast.message}
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal />

      {/* Auth Modal */}
      <AuthModal />

      {/* AI Modal */}
      <AiModalView />

      {/* Header Application Shell */}
      <header className="bg-slate-900 text-white sticky top-0 z-40 shadow-md">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigateTo('dashboard')}>
            <div className="bg-gradient-to-tr from-blue-600 to-indigo-500 p-2 rounded-xl text-white shadow-inner">
              <Library size={22} />
            </div>
            <div>
              <h1 className="font-extrabold text-base tracking-tight leading-none text-white">Libri di Maurizio</h1>
              <p className="text-[10px] text-slate-400 font-medium">La Mia Libreria Digitale AI</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Sync status indicator */}
            <div className="flex items-center gap-1 bg-slate-800 border border-slate-700 p-1.5 rounded-lg text-xs font-medium">
              {syncStatus === 'synced' && <UploadCloud size={14} className="text-emerald-400" title="Sincronizzato Cloud" />}
              {syncStatus === 'syncing' && <RefreshCw size={14} className="text-blue-400 animate-spin" title="Sincronizzazione..." />}
              {syncStatus === 'error' && <UploadCloud size={14} className="text-red-400" title="Errore Sincronizzazione" />}
              {syncStatus === 'offline' && <UploadCloud size={14} className="text-slate-500" title="Modalità Locale (Scollegato)" />}
              <span className="text-[10px] text-slate-400 hidden md:inline uppercase">
                {syncStatus === 'synced' ? 'Cloud' : syncStatus === 'syncing' ? 'Sync...' : syncStatus === 'error' ? 'Errore' : 'Locale'}
              </span>
            </div>

            {/* Auth Button */}
            {user ? (
              <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 p-1 rounded-lg">
                <span className="text-[11px] text-slate-300 font-bold px-1.5 truncate max-w-[100px]">{user.email.split('@')[0]}</span>
                <button 
                  onClick={() => {
                    if (auth) {
                      auth.signOut().then(() => showToast("Disconnessione completata."));
                    }
                  }} 
                  className="px-2 py-1 bg-red-900/60 hover:bg-red-800 text-red-100 rounded text-[10px] font-bold cursor-pointer transition-colors"
                >
                  Logout
                </button>
              </div>
            ) : (
              <button 
                onClick={() => setIsAuthModalOpen(true)}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <UploadCloud size={14} />
                <span>Accedi Cloud</span>
              </button>
            )}

            {/* API Key Settings Button */}
            <button onClick={openApiKeySettings} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer">
              <Key size={14} className={apiKey ? "text-emerald-400" : "text-amber-400"} />
              <span className="hidden sm:inline">{apiKey ? "API Key Impostata" : "Imposta API Key"}</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="bg-slate-800 border-t border-slate-700 px-4 overflow-x-auto scrollbar-hide">
          <div className="max-w-7xl mx-auto flex space-x-1 py-1 text-xs">
            <button onClick={() => navigateTo('dashboard')} className={`px-4 py-2 rounded-lg font-bold flex items-center whitespace-nowrap transition-colors cursor-pointer ${activeTab === 'dashboard' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
              <BookOpen size={15} className="mr-1.5" /> Dashboard
            </button>
            <button onClick={() => navigateTo('libreria')} className={`px-4 py-2 rounded-lg font-bold flex items-center whitespace-nowrap transition-colors cursor-pointer ${activeTab === 'libreria' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
              <Library size={15} className="mr-1.5" /> La Mia Libreria ({books.length})
            </button>
            <button onClick={() => navigateTo('esplora_novita')} className={`px-4 py-2 rounded-lg font-bold flex items-center whitespace-nowrap transition-colors cursor-pointer ${activeTab === 'esplora_novita' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
              <Wand2 size={15} className="mr-1.5 text-indigo-400" /> Novità Consigliate
            </button>
            <button onClick={() => navigateTo('cerca_online')} className={`px-4 py-2 rounded-lg font-bold flex items-center whitespace-nowrap transition-colors cursor-pointer ${activeTab === 'cerca_online' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
              <Search size={15} className="mr-1.5" /> Cerca Web
            </button>
            <button onClick={() => navigateTo('import_export')} className={`px-4 py-2 rounded-lg font-bold flex items-center whitespace-nowrap transition-colors cursor-pointer ${activeTab === 'import_export' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
              <Download size={15} className="mr-1.5" /> Backup & CSV
            </button>
          </div>
        </nav>
      </header>

      {/* Main View Container con ErrorBoundary per prevenire schermata bianca */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6">
        <ErrorBoundary>
          {activeTab === 'dashboard' && <DashboardView />}
          {activeTab === 'libreria' && <LibreriaView />}
          {(activeTab === 'esplora_novita' || activeTab === 'esplora_bestseller') && (
            <EsploraOnlineView results={novitaResults} setResults={setNovitaResults} />
          )}
          {activeTab === 'cerca_online' && (
            <CercaOnlineView data={cercaResults} setData={setCercaResults} />
          )}
          {activeTab === 'import_export' && <ImportBackupView />}
          {activeTab === 'scheda_libro' && <SchedaLibro key={selectedBook ? selectedBook.id : 'nuovo-libro'} />}
        </ErrorBoundary>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row justify-between items-center gap-2">
          <span>📚 Libri di Maurizio &copy; {new Date().getFullYear()} — La tua libreria personale AI</span>
          <div className="flex gap-4">
            <button onClick={openApiKeySettings} className="hover:underline text-indigo-600 font-semibold cursor-pointer">Impostazioni AI Gemini</button>
            <button onClick={() => navigateTo('import_export')} className="hover:underline cursor-pointer">Esporta Backup</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
