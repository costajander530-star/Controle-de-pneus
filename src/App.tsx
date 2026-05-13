/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  Truck, 
  Database, 
  ClipboardCheck, 
  Settings, 
  Plus, 
  Search, 
  Menu, 
  X, 
  LogOut, 
  AlertTriangle,
  RotateCcw,
  Zap,
  TrendingDown,
  Clock,
  ArrowRight,
  Trash2,
  Map,
  Download,
  History,
  Package,
  Repeat,
  Hammer,
  Save,
  Bell,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, signInWithGoogle, logout, handleFirestoreError, OperationType } from './services/firebase';
import { onAuthStateChanged, User as FirebaseUser, signInAnonymously } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, onSnapshot, query, where, orderBy, deleteDoc, updateDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';
import { UserProfile, Tire, Equipment, Inspection, WorkOrder, TireStatus, EquipmentStatus } from './types';
import { cn } from './lib/utils';
import { seedInitialData } from './services/seed';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// --- Helper Functions ---

const generateGeneralReportPDF = (tires: Tire[], equipment: Equipment[]) => {
  const doc = new jsPDF();
  const date = new Date().toLocaleDateString();

  doc.setFontSize(22);
  doc.setTextColor(45, 55, 72);
  doc.text("TyreTrack Pro - Relatório de Gestão", 14, 22);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Emissão: ${date} | Unidade Operacional`, 14, 30);

  // 1. Inventário Resumo
  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text("1. Resumo do Inventário", 14, 42);
  
  const inventoryData = [
    ["Ativos em Operação", tires.filter(t => t.status === 'in_use').length],
    ["Pneus em Estoque", tires.filter(t => t.status === 'inventory').length],
    ["Aguandando Reforma", tires.filter(t => t.status === 'to_be_retreaded').length],
    ["Sucata Total", tires.filter(t => t.status === 'scrapped').length]
  ];

  autoTable(doc, {
    startY: 46,
    head: [['Indicador', 'Quantidade']],
    body: inventoryData,
    theme: 'striped',
    headStyles: { fillColor: [45, 55, 72], fontStyle: 'bold' }
  });

  // 2. Status da Frota Ativa
  const lastY1 = (doc as any).lastAutoTable?.finalY || 80;
  doc.text("2. Status da Frota Ativa", 14, lastY1 + 15);
  
  const fleetData = equipment.map(eq => {
    const eqTires = tires.filter(t => t.equipmentId === eq.id);
    const avgLife = eqTires.length > 0 ? Math.round(eqTires.reduce((acc, t) => acc + t.currentHours, 0) / eqTires.length) : 0;
    const minTWI = eqTires.length > 0 ? Math.min(...eqTires.map(t => t.currentTreadDepth)) : 0;
    return [
      eq.tag,
      eq.model,
      `${eq.hourMeter}h`,
      `${eqTires.length}/12`,
      `${minTWI}mm`,
      minTWI < 10 ? 'URGENTE' : 'Ok'
    ];
  });

  autoTable(doc, {
    startY: lastY1 + 20,
    head: [['TAG', 'Modelo', 'Horas', 'Pneus', 'Min TWI', 'Status']],
    body: fleetData,
    theme: 'grid',
    headStyles: { fillColor: [66, 153, 225] },
    columnStyles: { 5: { fontStyle: 'bold' } }
  });

  // 3. Histórico de Trocas / Movimentações Recentes
  const lastY2 = (doc as any).lastAutoTable?.finalY || 150;
  if (lastY2 > 220) doc.addPage();
  
  const currentY = lastY2 > 220 ? 30 : lastY2 + 15;
  doc.text("3. Histórico de Movimentações (30 dias)", 14, currentY);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const movements = tires
    .filter(t => t.updatedAt && new Date(t.updatedAt).getTime() > thirtyDaysAgo.getTime())
    .map(t => {
      const eq = equipment.find(e => e.id === t.equipmentId);
      return [
        new Date(t.updatedAt).toLocaleDateString(),
        eq?.tag || 'ESTOQUE',
        t.dot,
        t.position || '-',
        t.status === 'in_use' ? 'Montagem/Rodízio' : 
        t.status === 'scrapped' ? 'Descarte' : 'Remoção'
      ];
    });

  autoTable(doc, {
    startY: currentY + 5,
    head: [['Data', 'Equipamento', 'Pneu (DOT)', 'Posição', 'Ação']],
    body: movements.length > 0 ? movements : [['-', 'Nenhuma movimentação registrada nos últimos 30 dias', '-', '-', '-']],
    theme: 'striped',
    headStyles: { fillColor: [34, 197, 94] }
  });

  doc.save(`relatorio_pro_${Date.now()}.pdf`);
};

const generateMonthlyBalancePDF = (tires: Tire[]) => {
  const doc = new jsPDF();
  const date = new Date().toLocaleDateString();

  doc.setFontSize(20);
  doc.text("Balanço Mensal de Movimentação", 14, 22);
  doc.setFontSize(10);
  doc.text(`Mês/Ano: ${new Date().toLocaleString('pt-BR', { month: 'long', year: 'numeric' })}`, 14, 30);

  // Group by arrival date (month)
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  
  const entries = tires.filter(t => {
    const d = new Date(t.arrivalDate || t.createdAt);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const scrapped = tires.filter(t => {
    if (t.status !== 'scrapped') return false;
    const d = new Date(t.updatedAt || t.createdAt);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const balanceData = [
    ["Entradas (Novos)", entries.filter(e => e.type === 'new').length],
    ["Entradas (Reformas)", entries.filter(e => e.type === 'retreaded').length],
    ["Saídas (Sucateamento)", scrapped.length],
    ["Saldo Líquido", entries.length - scrapped.length]
  ];

  autoTable(doc, {
    startY: 40,
    head: [['Movimentação', 'Quantidade']],
    body: balanceData,
    theme: 'striped',
    headStyles: { fillColor: [66, 153, 225] }
  });

  const lastY2 = (doc as any).lastAutoTable?.finalY || 80;
  doc.text("Lista de Entradas do Mês", 14, lastY2 + 15);
  
  const entryDetails = entries.map(e => [e.dot, e.brand, e.type === 'new' ? 'Novo' : 'Reformado', e.initialTreadDepth + 'mm']);

  autoTable(doc, {
    startY: lastY2 + 20,
    head: [['DOT', 'Marca', 'Tipo', 'Sulco Inicial']],
    body: entryDetails,
    theme: 'grid'
  });

  doc.save(`balanco_mensal_${Date.now()}.pdf`);
};

// --- Sub-components ---

const StatCard = ({ title, value, unit, trend, icon: Icon, color }: any) => (
  <motion.div 
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    className="bg-bg-section p-6 rounded-lg border border-border-subtle shadow-sm flex flex-col justify-between h-full"
  >
    <div className="flex justify-between items-start mb-6">
      <div className={cn("p-2.5 rounded font-mono text-xs uppercase font-bold tracking-widest bg-bg-deep border border-border-subtle flex items-center gap-2", color.replace('bg-', 'text-'))}>
        <Icon className="w-5 h-5" />
      </div>
      {trend !== undefined && (
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded border font-mono", trend < 0 ? "bg-emerald-900/20 text-emerald-400 border-emerald-500/30" : "bg-red-900/20 text-red-400 border-red-500/30")}>
          {trend > 0 ? "+" : ""}{trend}%
        </span>
      )}
    </div>
    <div>
      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1 leading-tight">{title}</p>
      <div className="flex items-baseline gap-2">
        <h3 className="text-3xl font-bold font-mono text-brand-primary tracking-tighter">{value}</h3>
        <span className="text-xs font-mono text-gray-400 uppercase">{unit}</span>
      </div>
    </div>
  </motion.div>
);

const TireAnchor = ({ pos, isActive, isConfigured, onClick, className }: { pos: string, isActive: boolean, isConfigured: boolean, onClick: () => void, key?: string | number, className?: string }) => (
  <motion.button
    whileHover={{ scale: 1.05 }}
    whileTap={{ scale: 0.95 }}
    onClick={onClick}
    className={cn(
      "w-12 h-16 rounded border-2 flex flex-col items-center justify-center transition-all shadow-md relative",
      isActive ? "border-brand-primary bg-brand-primary/20 ring-4 ring-brand-primary/10 z-20" : 
      isConfigured ? "border-emerald-500 bg-emerald-500/10" : "border-border-subtle bg-bg-surface text-gray-600",
      className
    )}
  >
    <span className={cn("font-mono text-lg font-black", isActive ? "text-brand-primary" : isConfigured ? "text-emerald-500" : "text-gray-500")}>{pos}</span>
    {isConfigured && <div className="absolute -top-1 -right-1 bg-emerald-500 w-2 h-2 rounded-full border border-bg-deep shadow-sm" />}
  </motion.button>
);

const TruckLayout = ({ equipment, tires }: { equipment: Equipment, tires: Tire[] }) => {
  // 12 tire layout: 
  // Axle 1 (Direcional): Pos 1 (E), Pos 2 (D)
  // Axle 2 (Direcional): Pos 3 (E), Pos 4 (D)
  // Axle 3 (Tração): Pos 5 (EE), 6 (EI), 7 (DI), 8 (ED)
  // Axle 4 (Tração): Pos 9 (EE), 10 (EI), 11 (DI), 12 (ED)
  const positions = [
    // Eixo Direcional 1
    { id: '1', label: '1E', x: '25%', y: '10%' },
    { id: '2', label: '1D', x: '75%', y: '10%' },
    // Eixo Direcional 2
    { id: '3', label: '2E', x: '25%', y: '25%' },
    { id: '4', label: '2D', x: '75%', y: '25%' },
    // Eixo Tração 1
    { id: '5', label: '3EE', x: '10%', y: '55%' },
    { id: '6', label: '3EI', x: '25%', y: '55%' },
    { id: '7', label: '3DI', x: '75%', y: '55%' },
    { id: '8', label: '3ED', x: '90%', y: '55%' },
    // Eixo Tração 2
    { id: '9', label: '4EE', x: '10%', y: '80%' },
    { id: '10', label: '4EI', x: '25%', y: '80%' },
    { id: '11', label: '4DI', x: '75%', y: '80%' },
    { id: '12', label: '4ED', x: '90%', y: '80%' },
  ];

  return (
    <div className="relative w-full aspect-[2/3] bg-bg-deep rounded-xl border border-border-subtle p-4 overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-center opacity-5 pointer-events-none">
        <Truck className="w-64 h-64" />
      </div>
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-[80%] bg-white/5 rounded-full blur-3xl" />
      
      {positions.map((pos) => {
        const tire = tires.find(t => t.position === pos.id);
        const isCritical = tire && tire.currentTreadDepth < 10;
        return (
          <motion.button
            key={pos.id}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            style={{ left: pos.x, top: pos.y }}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 w-12 h-16 rounded border flex flex-col items-center justify-center transition-all shadow-lg",
              tire 
                ? isCritical 
                  ? "bg-red-900/40 border-red-500 text-red-500 ring-4 ring-red-500/10 animate-pulse" 
                  : "bg-brand-secondary/20 border-brand-secondary text-brand-secondary" 
                : "bg-bg-deep border-border-subtle text-gray-700 hover:border-gray-500"
            )}
          >
            <span className="text-[7px] font-black uppercase mb-1 opacity-60 tracking-wider font-mono">{pos.label}</span>
            {tire ? (
              <div className="text-center">
                <span className="font-mono text-[10px] font-bold block">{tire.currentTreadDepth}</span>
                <span className="text-[6px] opacity-40 font-mono">{tire.dot.slice(-4)}</span>
              </div>
            ) : <Plus className="w-3 h-3" />}
          </motion.button>
        );
      })}
    </div>
  );
};

// --- Main App Component ---

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isManualAuth, setIsManualAuth] = useState(() => {
    return localStorage.getItem('isManualAuth') === 'true';
  });
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unitNameInput, setUnitNameInput] = useState('');
  const [defaultTireModelInput, setDefaultTireModelInput] = useState('');
  const [defaultTireSizeInput, setDefaultTireSizeInput] = useState('');
  const [loginCreds, setLoginCreds] = useState({ username: '', password: '' });
  const [view, setView] = useState<'dashboard' | 'inventory' | 'equipment' | 'inspections' | 'reports' | 'settings' | 'fleet-status' | 'alerts' | 'mapping'>('dashboard');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [tires, setTires] = useState<Tire[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [pendingInspections, setPendingInspections] = useState<Inspection[]>(() => {
    const saved = localStorage.getItem('pendingInspections');
    return saved ? JSON.parse(saved) : [];
  });
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isEditTireModalOpen, setIsEditTireModalOpen] = useState(false);
  const [selectedTireToEdit, setSelectedTireToEdit] = useState<Tire | null>(null);
  const [isRegisterTireModalOpen, setIsRegisterTireModalOpen] = useState(false);
  const [isRegisterEquipmentModalOpen, setIsRegisterEquipmentModalOpen] = useState(false);
  const [activeEquipmentId, setActiveEquipmentId] = useState<string | null>(null);
  const [selectedTireIdForInspection, setSelectedTireIdForInspection] = useState<string | null>(null);
  const [selectedMappingEquipmentId, setSelectedMappingEquipmentId] = useState<string | null>(null);
  const [inspectionMode, setInspectionMode] = useState<'inspect' | 'rotate'>('inspect');
  const [isReplacementModalOpen, setIsReplacementModalOpen] = useState(false);
  const [replacementPosition, setReplacementPosition] = useState<string | null>(null);
  const [replacementData, setReplacementData] = useState({
    tireId: '',
    twi: 45,
    pressure: 105,
    type: 'new' as 'new' | 'retreaded' | 'repaired'
  });

  const handleApplyRotation = async (fromId: string, toPos: string) => {
    if (!activeEquipmentId) return;
    const path = `tires/${fromId}`;
    try {
      const tireAtPos = tires.find(t => t.equipmentId === activeEquipmentId && t.position === toPos);
      const fromTire = tires.find(t => t.id === fromId);
      if (!fromTire) return;

      const fromPos = fromTire.position;
      await updateDoc(doc(db, 'tires', fromTire.id), { position: toPos, updatedAt: serverTimestamp() });
      if (tireAtPos) {
        await updateDoc(doc(db, 'tires', tireAtPos.id), {
          position: fromPos || null,
          status: fromPos ? 'in_use' : 'inventory',
          equipmentId: fromPos ? activeEquipmentId : null,
          updatedAt: serverTimestamp()
        });
      }
      alert("Configuração salva com sucesso! Rodízio aplicado.");
      setSelectedTireIdForInspection(null);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, path);
    }
  };

  const [inspectionValues, setInspectionValues] = useState({ twi: 45, psi: 105, psiAfter: 105 });

  const handleSaveInspection = async () => {
    if (!selectedTireIdForInspection || !activeEquipmentId) return;
    const inspectionId = crypto.randomUUID();
    
    // 1. Prepare data (Date will be updated to serverTimestamp during sync)
    const activeEq = equipment.find(e => e.id === activeEquipmentId);
    const inspectionData: Inspection = {
      id: inspectionId,
      tireId: selectedTireIdForInspection,
      equipmentId: activeEquipmentId,
      inspectorId: profile?.uid || 'anonymous',
      date: new Date() as any, // Temporary local date
      treadDepthPoints: [inspectionValues.twi],
      temperature: 0,
      pressure: inspectionValues.psiAfter,
      equipmentHourMeter: activeEq?.hourMeter || 0,
      condition: 'Normal'
    };

    // 2. Add to Pending list immediately for UI feedback and persistence
    setPendingInspections(prev => [...prev, inspectionData]);
    setSelectedTireIdForInspection(null);

    // 3. Try to sync immediately if online
    if (isOnline) {
      // Small timeout to let the state update and UI respond
      setTimeout(() => syncPendingData(), 500);
    } else {
      alert("Você está offline. A inspeção foi salva localmente e será sincronizada assim que a conexão for restabelecida.");
    }
  };

  const handleReplaceTire = async () => {
    if (!activeEquipmentId || !replacementPosition || !replacementData.tireId) return;
    try {
      const oldTire = tires.find(t => t.equipmentId === activeEquipmentId && t.position === replacementPosition);
      const newTire = tires.find(t => t.id === replacementData.tireId);
      if (!newTire) return;

      // 1. Unmount old tire if exists
      if (oldTire) {
        await updateDoc(doc(db, 'tires', oldTire.id), {
          status: 'to_be_retreaded',
          equipmentId: null,
          position: null,
          updatedAt: serverTimestamp()
        });
      }

      // 2. Mount new tire
      await updateDoc(doc(db, 'tires', newTire.id), {
        status: 'in_use',
        equipmentId: activeEquipmentId,
        position: replacementPosition,
        currentTreadDepth: replacementData.twi,
        pressure: replacementData.pressure,
        type: replacementData.type,
        updatedAt: serverTimestamp()
      });

      // 3. Create inspection record
      const activeEq = equipment.find(e => e.id === activeEquipmentId);
      const inspectionId = crypto.randomUUID();
      await setDoc(doc(db, 'inspections', inspectionId), {
        id: inspectionId,
        tireId: newTire.id,
        equipmentId: activeEquipmentId,
        inspectorId: profile?.uid || 'anonymous',
        date: serverTimestamp(),
        treadDepthPoints: [replacementData.twi],
        temperature: 0,
        pressure: replacementData.pressure,
        equipmentHourMeter: activeEq?.hourMeter || 0,
        condition: 'Montagem/Substituição'
      });

      alert("Substituição realizada com sucesso!");
      setIsReplacementModalOpen(false);
      setReplacementPosition(null);
      setReplacementData({ tireId: '', twi: 45, pressure: 105, type: 'new' });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, 'tires');
    }
  };

  const [newBatch, setNewBatch] = useState<{
    arrivalDate: string;
    brand: string;
    batchName: string;
    type: 'new' | 'retreaded';
    status: TireStatus;
    tires: { dot: string; treadDepth: number; brand: string }[];
  }>({
    arrivalDate: new Date().toISOString().split('T')[0],
    brand: '',
    batchName: '',
    type: 'new',
    status: 'inventory',
    tires: []
  });

  const [newEquipment, setNewEquipment] = useState({
    id: '', 
    tag: '',
    model: 'CAT 793F',
    hourMeter: 0,
    registrationDate: new Date().toISOString().split('T')[0],
    status: 'in_operation' as EquipmentStatus,
    selectedPosition: '1',
    tires: Array.from({ length: 12 }, (_, i) => ({
      position: (i + 1).toString(),
      dot: '',
      brand: '',
      batchName: '',
      type: 'new' as 'new' | 'retreaded',
      status: 'in_use' as TireStatus,
      treadDepth: 45,
      pressure: 105
    }))
  });

  const handleRegisterBatch = async () => {
    if (!newBatch.brand || !newBatch.batchName || newBatch.tires.length === 0) return;
    try {
      for (const t of newBatch.tires) {
        const tireId = crypto.randomUUID();
        const tire: Tire = {
          id: tireId,
          dot: t.dot || `${newBatch.batchName}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
          batchName: newBatch.batchName,
          brand: t.brand || newBatch.brand,
          model: profile?.defaultTireModel || '2400R35',
          size: profile?.defaultTireSize || '35"',
          type: newBatch.type,
          acquisitionCost: 15000,
          initialTreadDepth: t.treadDepth,
          expectedHours: 5000,
          expectedWearMm: 0.01,
          status: newBatch.status,
          currentHours: 0,
          currentTreadDepth: t.treadDepth,
          arrivalDate: newBatch.arrivalDate,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        await setDoc(doc(db, 'tires', tireId), tire);
      }
      setIsRegisterTireModalOpen(false);
      setNewBatch({ arrivalDate: new Date().toISOString().split('T')[0], brand: '', batchName: '', type: 'new', status: 'inventory', tires: [] });
      alert("Configuração salva com sucesso! Pneus registrados no estoque.");
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'tires');
    }
  };

  const handleRegisterEquipment = async () => {
    if (!newEquipment.tag) return;

    if (equipment.some(e => e.tag.trim().toUpperCase() === newEquipment.tag.trim().toUpperCase() && e.id !== newEquipment.id)) {
      alert("Erro: Já existe outro equipamento cadastrado com esta TAG!");
      return;
    }

    try {
      const equipmentId = newEquipment.id || crypto.randomUUID();
      const eq: Equipment = {
        id: equipmentId,
        tag: newEquipment.tag,
        model: newEquipment.model,
        hourMeter: newEquipment.hourMeter,
        loadCapacity: 240,
        operationType: 'Mining',
        site: profile?.unitName || 'Mina Principal',
        status: newEquipment.status as EquipmentStatus,
        registrationDate: newEquipment.registrationDate
      };
      await setDoc(doc(db, 'equipment', equipmentId), eq);

      for (const t of newEquipment.tires) {
        if (!t.dot) continue;
        const existingTire = tires.find(tire => tire.dot === t.dot);
        const tireId = existingTire?.id || crypto.randomUUID();
        
        const tireData: Tire = {
          id: tireId,
          dot: t.dot,
          batchName: t.batchName || existingTire?.batchName || 'Lote Indefinido',
          brand: t.brand || (existingTire?.brand ?? 'Genérica'),
          model: existingTire?.model ?? profile?.defaultTireModel ?? '2400R35',
          size: existingTire?.size ?? profile?.defaultTireSize ?? '35"',
          type: t.type,
          acquisitionCost: existingTire?.acquisitionCost ?? 15000,
          initialTreadDepth: existingTire?.initialTreadDepth ?? t.treadDepth,
          expectedHours: existingTire?.expectedHours ?? 5000,
          expectedWearMm: existingTire?.expectedWearMm ?? 0.01,
          status: t.status || 'in_use',
          currentHours: existingTire?.currentHours ?? 0,
          currentTreadDepth: t.treadDepth || existingTire?.currentTreadDepth || 0,
          pressure: t.pressure || 0,
          equipmentId: (t.status || 'in_use') === 'in_use' ? equipmentId : null,
          position: (t.status || 'in_use') === 'in_use' ? t.position : null,
          arrivalDate: existingTire?.arrivalDate ?? newEquipment.registrationDate,
          createdAt: existingTire?.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        await setDoc(doc(db, 'tires', tireId), tireData);

        // Create initial inspection for documentation
        if (tireData.equipmentId) {
          const inspectionId = crypto.randomUUID();
          await setDoc(doc(db, 'inspections', inspectionId), {
            id: inspectionId,
            tireId: tireId,
            equipmentId: equipmentId,
            inspectorId: profile?.uid || 'anonymous',
            date: serverTimestamp(),
            treadDepthPoints: [tireData.currentTreadDepth],
            temperature: 0,
            pressure: tireData.pressure,
            equipmentHourMeter: eq.hourMeter,
            condition: 'Montagem Inicial'
          });
        }
      }
      setIsRegisterEquipmentModalOpen(false);
      alert("Configuração salva com sucesso!");
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'equipment');
    }
  };

  const handleSeed = async () => {
    if (confirm("Seed initial database data?")) {
      await seedInitialData();
      alert("Seeding complete!");
    }
  };

  const handleDiscardEquipment = async (id: string) => {
    if (!window.confirm("Deseja realmente descartar este equipamento? Esta ação removerá o ativo e liberará os pneus vinculados. Esta ação é irreversível.")) return;
    try {
      await deleteDoc(doc(db, 'equipment', id));
      
      // Liberar pneus vinculados
      const relatedTires = tires.filter(t => t.equipmentId === id);
      for (const tire of relatedTires) {
        await updateDoc(doc(db, 'tires', tire.id), { 
          equipmentId: null, 
          position: null, 
          status: 'inventory',
          updatedAt: new Date().toISOString()
        });
      }
      
      if (activeEquipmentId === id) setActiveEquipmentId(null);
      alert("Equipamento descartado com sucesso.");
    } catch (error) {
      console.error("Error discarding equipment:", error);
      alert("Erro ao descartar equipamento.");
    }
  };

  const handleDeleteTire = async (id: string, dot: string) => {
    if (!window.confirm(`Deseja realmente excluir o pneu ${dot}? Esta ação é irreversível e removerá todo o histórico associado.`)) return;
    try {
      await deleteDoc(doc(db, 'tires', id));
      alert("Pneu excluído com sucesso.");
    } catch (error) {
      console.error("Erro ao excluir pneu:", error);
      alert("Erro ao excluir pneu. Verifique suas permissões.");
      handleFirestoreError(error, OperationType.DELETE, `tires/${id}`);
    }
  };

  const handleDeleteInspection = async (id: string) => {
    if (!window.confirm("Deseja realmente remover este registro de inspeção?")) return;
    try {
      await deleteDoc(doc(db, 'inspections', id));
      alert("Inspeção removida com sucesso.");
    } catch (error) {
      console.error("Erro ao remover inspeção:", error);
      alert("Erro ao remover inspeção.");
      handleFirestoreError(error, OperationType.DELETE, `inspections/${id}`);
    }
  };

  const handleLogout = async () => {
    setIsManualAuth(false);
    localStorage.removeItem('isManualAuth');
    await logout();
    setProfile(null);
  };

  const updateSettings = async () => {
    if ((!user && !isManualAuth) || !profile) return;
    try {
      const updatedProfile: UserProfile = { 
        ...profile, 
        unitName: unitNameInput,
        defaultTireModel: defaultTireModelInput,
        defaultTireSize: defaultTireSizeInput
      };
      const userId = user?.uid || 'manual-admin';
      await setDoc(doc(db, 'users', userId), updatedProfile);
      setProfile(updatedProfile);
      alert("Configurações atualizadas com sucesso!");
    } catch (error) {
      console.error(error);
      alert("Erro ao atualizar configurações.");
    }
  };

  // Authentication Listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthChecked(true);
      
      // If we have a user, check if it's a "real" user (Google login) or anonymous
      if (u && !u.isAnonymous) {
        // Only reset manual auth if it's a "real" Google Login
        setIsManualAuth(false);
        localStorage.removeItem('isManualAuth');
      }
    });
    return unsub;
  }, []);

  // Profile Real-time Sync
  useEffect(() => {
    if (!authChecked) return;
    
    let uid: string | null = null;
    if (isManualAuth) {
      uid = 'manual-admin';
    } else if (user) {
      uid = user.uid;
    }

    if (!uid) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const docRef = doc(db, 'users', uid);
    
    // Using onSnapshot to keep configuration synced across devices
    const unsubProfile = onSnapshot(docRef, async (snap) => {
      if (snap.exists()) {
        const profileData = snap.data() as UserProfile;
        setProfile(profileData);
        setUnitNameInput(profileData.unitName || '');
        setDefaultTireModelInput(profileData.defaultTireModel || '2400R35');
        setDefaultTireSizeInput(profileData.defaultTireSize || '35"');
        setLoading(false);
      } else {
        // Initialize default profile if it doesn't exist
        const defaultProfile: UserProfile = {
          uid: uid,
          name: isManualAuth ? 'Terminal MPC' : (user?.displayName || 'Usuário'),
          email: isManualAuth ? 'admin@mpcpneus.com.br' : (user?.email || ''),
          role: 'admin',
          unitName: isManualAuth ? 'Unidade Central MPC' : 'Mina Itabira - Setor Norte',
          defaultTireModel: '2400R35',
          defaultTireSize: '35"'
        };
        
        if (isOnline && (user || auth.currentUser)) {
          try {
            await setDoc(docRef, defaultProfile);
          } catch (e) {
            console.warn("Could not save initial profile to cloud");
          }
        }
        setProfile(defaultProfile);
        setLoading(false);
      }
    }, (err) => {
      console.error("Profile sync error:", err);
      if (err.code === 'permission-denied') {
        setSyncError("Acesso restrito ao perfil. Verifique seu login.");
      }
      setLoading(false);
    });

    return unsubProfile;
  }, [user, isManualAuth, authChecked]);

  useEffect(() => {
    localStorage.setItem('pendingInspections', JSON.stringify(pendingInspections));
  }, [pendingInspections]);

  // Automatic Sync System
  useEffect(() => {
    if (isOnline && pendingInspections.length > 0 && !isSyncing && profile) {
      syncPendingData();
    }
  }, [isOnline, pendingInspections.length, isSyncing, profile]);

  const syncPendingData = async () => {
    if (!isOnline || pendingInspections.length === 0 || isSyncing) return;
    setIsSyncing(true);
    console.log(`Syncing ${pendingInspections.length} pending inspections...`);
    
    const successfullySynced: string[] = [];

    for (const inspection of pendingInspections) {
      try {
        if (!auth.currentUser) break;
        
        const docRef = doc(db, 'inspections', inspection.id);
        const docSnap = await getDoc(docRef);
        
        if (!docSnap.exists()) {
          const batch = writeBatch(db);
          batch.set(docRef, { ...inspection, date: serverTimestamp(), syncDate: serverTimestamp() });
          
          const tireRef = doc(db, 'tires', inspection.tireId);
          batch.update(tireRef, {
            currentTreadDepth: inspection.treadDepthPoints[0],
            pressure: inspection.pressure,
            updatedAt: serverTimestamp()
          });
          
          await batch.commit();
        }
        successfullySynced.push(inspection.id);
      } catch (error) {
        console.error(`Failed to sync inspection ${inspection.id}:`, error);
      }
    }

    setPendingInspections(prev => prev.filter(p => !successfullySynced.includes(p.id)));
    setIsSyncing(false);
  };


  // Real-time Data Sync
  useEffect(() => {
    // We need an authenticated system user (Google or Anonymous) 
    // to satisfy Security Rules (request.auth != null)
    if (!authChecked || !auth.currentUser) return;

    setSyncError(null);

    const unsubTires = onSnapshot(collection(db, 'tires'), (snap) => {
      setTires(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Tire)));
    }, (err) => {
      console.error("Tires sync error:", err);
      setSyncError("Problema ao sincronizar pneus. Verifique sua permissão.");
    });

    const unsubEq = onSnapshot(collection(db, 'equipment'), (snap) => {
      setEquipment(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Equipment)));
    }, (err) => {
      console.error("Equipment sync error:", err);
    });

    const unsubInsp = onSnapshot(collection(db, 'inspections'), (snap) => {
      setInspections(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Inspection)));
    }, (err) => {
      console.error("Inspections sync error:", err);
    });

    const unsubWork = onSnapshot(collection(db, 'workOrders'), (snap) => {
      setWorkOrders(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as WorkOrder)));
    }, (err) => {
      console.error("Work orders sync error:", err);
    });

    return () => {
      unsubTires();
      unsubEq();
      unsubInsp();
      unsubWork();
    };
  }, [user, authChecked]);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-bg-deep">
      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          <div className="h-16 w-16 rounded border-4 border-gray-800 border-t-brand-primary animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-2 h-2 bg-brand-primary rounded-full animate-pulse" />
          </div>
        </div>
        <div className="text-center">
          <p className="text-brand-primary font-black text-xs tracking-[0.3em] uppercase mb-1">Inicializando Sistema</p>
          <p className="text-gray-600 font-mono text-[10px] uppercase">Carregando Núcleo v4.2...</p>
        </div>
      </div>
    </div>
  );

  if (!user && !isManualAuth) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg-deep text-[#e2e8f0] p-6 relative overflow-hidden select-none">
      <div className="absolute inset-0 bg-[#0c0d0f] opacity-50" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-primary/5 rounded-full blur-[120px] pointer-events-none" />
      
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-md w-full text-center z-10 p-12 bg-bg-section border border-border-subtle rounded shadow-2xl"
      >
        <div className="bg-brand-primary w-20 h-20 rounded flex items-center justify-center mx-auto mb-10 shadow-[0_0_30px_rgba(203,213,225,0.2)] transform -rotate-6">
          <span className="text-black font-black text-3xl">TK</span>
        </div>
        <h1 className="text-4xl font-black mb-2 tracking-tighter uppercase">TyreTrack Pro</h1>
        <p className="text-gray-500 mb-12 text-xs font-bold uppercase tracking-widest leading-loose">Inteligência Operacional para Gestão de Ativos de Grande Porte</p>
        
        <div className="space-y-4 mb-8">
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 text-left">Usuário</label>
            <input 
              type="text" 
              value={loginCreds.username}
              onChange={(e) => setLoginCreds({...loginCreds, username: e.target.value})}
              className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none"
              placeholder="Digite seu usuário"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 text-left">Senha</label>
            <input 
              type="password" 
              value={loginCreds.password}
              onChange={(e) => setLoginCreds({...loginCreds, password: e.target.value})}
              className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none"
              placeholder="••••••••"
            />
          </div>
        </div>

        <button 
          onClick={async () => {
            if (loginCreds.username === 'MPCpneus' && loginCreds.password === '@Mpc2026') {
              try {
                setIsLoggingIn(true);
                // Perform anonymous login to have a valid Firebase context for Sync
                try {
                  await signInAnonymously(auth);
                } catch (authError: any) {
                  console.warn("Anonymous auth failed, attempting fallback (Sync may be limited):", authError);
                  if (authError?.code === 'auth/operation-not-allowed') {
                     throw new Error("O 'Login Anônimo' não está habilitado no seu Console Firebase. Para corrigir isso e permitir sincronização entre dispositivos, habilite o provider 'Anônimo' na aba Autenticação do seu projeto.");
                  }
                }
                localStorage.setItem('isManualAuth', 'true');
                setIsManualAuth(true);
              } catch (error) {
                console.error("Erro ao autenticar terminal:", error);
                const msg = error instanceof Error ? error.message : String(error);
                alert(`Falha técnica no acesso: ${msg}.\n\nSe o erro persistir, utilize o Login com Google (Suporte).`);
              } finally {
                setIsLoggingIn(false);
              }
            } else {
              alert("Credenciais inválidas!");
            }
          }}
          disabled={isLoggingIn}
          className="w-full bg-brand-primary text-black font-black py-4 rounded hover:brightness-110 disabled:opacity-50 transition-all flex items-center justify-center gap-4 shadow-[0_0_20px_rgba(226,232,240,0.15)] active:scale-95 uppercase tracking-widest text-xs"
        >
          {isLoggingIn ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Sincronizando...
            </>
          ) : (
            'Acessar Terminal'
          )}
        </button>

        <div className="mt-8">
          <button 
            onClick={signInWithGoogle}
            className="text-[9px] font-bold text-gray-500 uppercase tracking-widest hover:text-white transition-colors"
          >
            Ou acessar com Google (Suporte)
          </button>
        </div>
        
        <div className="mt-12 pt-8 border-t border-border-subtle flex justify-between items-center opacity-40">
           <span className="text-[10px] font-mono">CODE: 01-ITAB-24</span>
           <span className="text-[10px] font-mono">STABLE v4.2.1</span>
        </div>
      </motion.div>
    </div>
  );

  const NavItem = ({ id, label, icon: Icon }: any) => (
    <button
      onClick={() => { setView(id); setIsMobileMenuOpen(false); }}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded font-bold transition-all w-full text-left uppercase text-[11px] tracking-widest",
        view === id 
          ? "bg-bg-card text-brand-primary border-l-2 border-brand-primary" 
          : "text-gray-500 hover:bg-bg-card hover:text-[#e2e8f0]"
      )}
    >
      <Icon className="w-4 h-4" />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="min-h-screen bg-bg-deep flex font-sans text-[#e2e8f0]">
      {/* Sidebar - Desktop */}
      <aside className="hidden lg:flex flex-col w-24 bg-bg-surface border-r border-border-subtle p-4 sticky top-0 h-screen items-center">
        <div className="mb-12">
          <div className="bg-brand-primary w-12 h-12 rounded flex items-center justify-center shadow-[0_0_15px_rgba(226,232,240,0.3)]">
            <span className="text-black font-black text-xl">TK</span>
          </div>
        </div>
        
        <nav className="flex-1 space-y-6 w-full">
          <NavItem id="dashboard" label="Painel" icon={LayoutDashboard} />
          <NavItem id="mapping" label="Mapeamento" icon={Map} />
          <NavItem id="alerts" label="Alertas Críticos" icon={AlertTriangle} />
          <NavItem id="fleet-status" label="Status Frota" icon={Truck} />
          <NavItem id="equipment" label="Frota Ativa" icon={Truck} />
          <NavItem id="inventory" label="Estoque Pneus" icon={Database} />
          <NavItem id="inspections" label="Inspeções" icon={ClipboardCheck} />
          <NavItem id="reports" label="Relatórios" icon={LayoutDashboard} />
          <NavItem id="settings" label="Ajustes" icon={Settings} />
          
          <div className="pt-4 mt-4 border-t border-border-subtle">
            <button 
              onClick={handleSeed}
              className="w-full text-[8px] font-black text-gray-600 hover:text-brand-primary uppercase tracking-[0.2em] text-center"
            >
              LIMPAR / SEED
            </button>
          </div>
        </nav>

        <div className="mt-auto space-y-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full ${isOnline ? 'bg-green-500/20 border-green-500/30' : 'bg-red-500/20 border-red-500/30'} border flex items-center justify-center ${isOnline ? 'animate-pulse' : ''}`}>
              <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`} />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-gray-500 tracking-widest">{isOnline ? 'CONNECTED' : 'DISCONNECTED'}</span>
              {pendingInspections.length > 0 && <span className="text-[8px] font-bold text-yellow-500 truncate">{pendingInspections.length} SYNC PENDING</span>}
            </div>
          </div>
          <button 
            onClick={handleLogout}
            className="p-3 text-red-400 hover:bg-red-900/20 rounded transition-all w-full flex items-center gap-3"
            title="LOGOUT"
          >
            <LogOut className="w-5 h-5" />
            <span className="text-[10px] font-black tracking-[0.2em]">SESSÃO / SAIR</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-20 border-b border-border-subtle flex items-center justify-between px-8 lg:px-12 bg-bg-surface z-30">
          <div className="flex flex-col">
            <h1 className="text-[10px] font-bold tracking-[0.3em] text-gray-500 uppercase">Motor de Inteligência de Frota v4.2</h1>
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold tracking-tight">Unidade: {profile?.unitName || 'Mina Itabira - Setor Norte'}</span>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 ${isOnline ? 'bg-green-500/20 text-green-500 border-green-500/30' : 'bg-red-500/20 text-red-500 border-red-500/30'} text-[10px] rounded border uppercase font-bold`}>
                  {isOnline ? 'CONEXÃO ESTÁVEL' : 'OFFLINE'}
                </span>
                {syncError && (
                  <span className="px-2 py-0.5 bg-red-600/90 text-white text-[10px] rounded animate-pulse font-black">
                    ERRO DE SINCRONIZAÇÃO
                  </span>
                )}
                {pendingInspections.length > 0 && (
                  <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-500 text-[10px] rounded border border-yellow-500/30 uppercase font-bold flex items-center gap-1">
                    {pendingInspections.length} PENDENTES {isSyncing && <RefreshCw className="w-2.5 h-2.5 animate-spin" />}
                  </span>
                )}
              </div>
            </div>
          </div>
          
          <div className="hidden md:flex gap-8 items-center border-l border-border-subtle pl-8">
            <div className="text-right">
              <div className="text-[10px] text-gray-500 uppercase font-mono tracking-widest">Média CP/H Frota</div>
              <div className="text-xl font-mono text-brand-primary">$12.84</div>
            </div>
            <button className="bg-brand-secondary text-white font-black px-6 py-2.5 rounded text-xs uppercase hover:brightness-110 transition-all shadow-[0_0_15px_rgba(34,197,94,0.2)]">
              NOVA INSPEÇÃO
            </button>
          </div>
          
          <button className="lg:hidden" onClick={() => setIsMobileMenuOpen(true)}>
            <Menu className="w-8 h-8" />
          </button>
        </header>

        {/* View Content */}
        <div className="p-6 lg:p-12 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {view === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                {/* Lembretes de Inspeção & Módulo de Alerta */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="p-6 bg-brand-primary/10 border border-brand-primary/20 rounded-lg flex items-center gap-6 shadow-sm">
                    <Clock className="w-10 h-10 text-brand-primary" />
                    <div>
                      <p className="text-[10px] font-black text-brand-primary uppercase tracking-[0.2em] mb-1">Rotina de Manutenção</p>
                      <p className="text-xs text-gray-300 leading-tight">Configuração de inspeção preventiva mensal ativa para 100% da frota.</p>
                    </div>
                  </div>
                  
                  {(() => {
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                    
                    const pendingEquipment = equipment.filter(eq => {
                      const lastInsp = inspections
                        .filter(i => i.equipmentId === eq.id)
                        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                      
                      return !lastInsp || new Date(lastInsp.date).getTime() < thirtyDaysAgo.getTime();
                    });

                    if (pendingEquipment.length === 0) return (
                      <div className="p-6 bg-emerald-900/10 border border-emerald-500/20 rounded-lg flex items-center gap-6 md:col-span-2">
                        <Zap className="w-10 h-10 text-emerald-500" />
                        <div>
                          <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.2em] mb-1">Status da Frota: Nominal</p>
                          <p className="text-xs text-gray-400">Todos os ativos estão com inspeções atualizadas dentro do ciclo de 30 dias.</p>
                        </div>
                      </div>
                    );

                    return (
                      <div className="md:col-span-2 bg-red-950/20 border border-red-500/30 rounded-lg overflow-hidden flex flex-col md:flex-row">
                        <div className="p-6 bg-red-500/10 flex items-center gap-6 border-b md:border-b-0 md:border-r border-red-500/20">
                          <AlertTriangle className="w-12 h-12 text-red-500 animate-pulse" />
                          <div className="min-w-[140px]">
                            <p className="text-[10px] font-black text-red-500 uppercase tracking-[0.2em] mb-1">ALERTA DE INSPEÇÃO</p>
                            <p className="text-2xl font-mono font-black text-white">{pendingEquipment.length}<span className="text-xs ml-1 opacity-40 font-bold uppercase">Ativos</span></p>
                          </div>
                        </div>
                        <div className="p-6 flex-1 flex flex-wrap gap-2 items-center">
                          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest w-full mb-2">Equipamentos com inspeção atrasada (&gt;30 dias):</p>
                          {pendingEquipment.map(eq => (
                            <button 
                              key={eq.id}
                              onClick={() => { setView('inspections'); setActiveEquipmentId(eq.id); }}
                              className="px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded text-[10px] font-mono font-bold text-red-400 hover:bg-red-500/20 transition-all uppercase tracking-wider"
                            >
                              {eq.tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1">Painel Operacional</h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Estatísticas Vitais da Frota</p>
                  </div>
                  <div className="flex gap-4">
                    <button className="bg-bg-section border border-border-subtle px-6 py-2.5 rounded font-bold text-xs hover:bg-bg-card transition-all uppercase tracking-widest text-[#e2e8f0]">
                       Exportar PDF
                    </button>
                    <button className="bg-brand-secondary text-white px-6 py-2.5 rounded font-black text-xs hover:brightness-110 transition-all uppercase tracking-widest shadow-[0_0_15px_rgba(34,197,94,0.2)]">
                      Novo Ativo
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
                  <StatCard title="Em Operação" value={tires.filter(t => t.status === 'in_use').length} unit="un" icon={Zap} color="text-brand-secondary" />
                  <StatCard title="Em Estoque" value={tires.filter(t => t.status === 'inventory').length} unit="un" icon={Database} color="text-indigo-400" />
                  <StatCard title="Total Novos" value={tires.filter(t => t.type === 'new').length} unit="un" icon={Package} color="text-sky-400" />
                  <StatCard title="Reformados" value={tires.filter(t => t.type === 'retreaded').length} unit="un" icon={Repeat} color="text-amber-400" />
                  <StatCard title="P/ Reforma" value={tires.filter(t => t.status === 'to_be_retreaded').length} unit="un" icon={Hammer} color="text-emerald-400" />
                  <StatCard title="Sucata" value={tires.filter(t => t.status === 'scrapped').length} unit="un" icon={Trash2} color="text-rose-400" />
                  <StatCard title="Duração Média" value={tires.filter(t => t.status === 'scrapped').length > 0 ? Math.round(tires.filter(t => t.status === 'scrapped').reduce((acc, t) => acc + t.currentHours, 0) / tires.filter(t => t.status === 'scrapped').length) : '0'} unit="H" icon={TrendingDown} color="text-brand-primary" />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <div className="xl:col-span-2 bg-bg-section p-8 rounded-lg border border-border-subtle">
                    <div className="flex items-center justify-between mb-8">
                      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Monitor de Alertas Críticos</h3>
                      <span className="text-[10px] font-bold uppercase text-brand-primary bg-brand-primary/10 px-3 py-1 rounded border border-brand-primary/30 tracking-widest">LIVE SCAN</span>
                    </div>
                    <div className="space-y-3">
                      {(() => {
                        const criticalTires = tires.filter(t => t.currentTreadDepth < 10);
                        const equipmentMap = equipment.reduce((acc, eq) => {
                          acc[eq.id] = eq;
                          return acc;
                        }, {} as Record<string, Equipment>);

                        const groupedByEq = criticalTires.reduce((acc, tire) => {
                          const eqId = tire.equipmentId || 'ESTOQUE';
                          if (!acc[eqId]) acc[eqId] = [];
                          acc[eqId].push(tire);
                          return acc;
                        }, {} as Record<string, Tire[]>);

                        if (criticalTires.length === 0) {
                          return (
                            <div className="text-center py-16">
                              <Zap className="w-12 h-12 mx-auto mb-4 text-brand-secondary opacity-20" />
                              <p className="text-gray-500 text-[10px] font-bold uppercase tracking-widest">Sem alertas críticos detectados</p>
                            </div>
                          );
                        }

                        return Object.entries(groupedByEq).map(([eqId, eqTires]) => {
                          const eq = equipmentMap[eqId];
                          const tiresList = eqTires as Tire[];
                          return (
                            <div key={eqId} className="p-5 bg-bg-deep border border-red-500/20 rounded-lg space-y-4">
                              <div className="flex justify-between items-center">
                                <div className="flex items-center gap-3">
                                  <Truck className="w-5 h-5 text-red-500" />
                                  <span className="font-mono text-sm font-bold text-white uppercase">{eq ? eq.tag : 'Estoque Central'}</span>
                                </div>
                                <span className="bg-red-500/10 text-red-500 text-[8px] font-black px-2 py-0.5 rounded border border-red-500/30 uppercase tracking-widest">Alerta Crítico</span>
                              </div>
                              <div className="space-y-2">
                                {tiresList.map(t => (
                                  <div key={t.id} className="flex items-center justify-between text-[10px] font-bold text-gray-400 pl-8 border-l border-red-500/20">
                                    <span>{t.dot} (POS {t.position || 'N/A'})</span>
                                    <span className="text-red-400 font-mono">{t.currentTreadDepth}mm</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>

                  <div className="bg-bg-section p-8 rounded-lg border border-border-subtle flex flex-col">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-8">Balanço de Estoque</h3>
                    
                    <div className="flex-1 space-y-6">
                      {[
                         { label: 'Pneus Novos', count: tires.filter(t => t.type === 'new' && t.status !== 'scrapped').length, color: 'bg-brand-secondary' },
                         { label: 'Pneus Reformados', count: tires.filter(t => t.type === 'retreaded' && t.status !== 'scrapped').length, color: 'bg-blue-500' },
                         { label: 'Para Reforma', count: tires.filter(t => t.status === 'retreading' || (t.status === 'in_use' && t.currentTreadDepth < 15 && t.type === 'new')).length, color: 'bg-amber-500' },
                         { label: 'Sucata Total', count: tires.filter(t => t.status === 'scrapped').length, color: 'bg-red-500' }
                      ].map((item, i) => (
                        <div key={i}>
                          <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest mb-2 opacity-60">
                            <span>{item.label}</span>
                            <span className="font-mono text-xs text-white">{item.count}</span>
                          </div>
                          <div className="w-full bg-bg-deep h-1.5 rounded-full overflow-hidden border border-border-subtle">
                            <div className={cn("h-full transition-all duration-1000", item.color)} style={{ width: `${(item.count / Math.max(tires.length, 1)) * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-12 pt-8 border-t border-border-subtle">
                      <button className="w-full py-3 bg-bg-card border border-border-subtle rounded text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-gray-800 transition-all flex items-center justify-center gap-3 text-gray-400 hover:text-white">
                        Ver Mais Painéis <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {view === 'mapping' && (
              <motion.div 
                key="mapping"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-12"
              >
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1 uppercase text-white">Mapeamento de Pneus</h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Análise detalhada por ativo e posição</p>
                  </div>
                  {!selectedMappingEquipmentId && (
                    <div className="bg-bg-card p-3 rounded-xl border border-border-subtle flex items-center gap-4">
                      <span className="w-3 h-3 rounded-full bg-brand-primary animate-pulse" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-white">Selecione um equipamento abaixo</span>
                    </div>
                  )}
                </div>

                {!selectedMappingEquipmentId ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-6">
                    {equipment.map(eq => (
                      <button 
                        key={eq.id}
                        onClick={() => setSelectedMappingEquipmentId(eq.id)}
                        className="bg-bg-section p-6 rounded-xl border border-border-subtle hover:border-brand-primary transition-all flex flex-col items-center gap-4 text-center group"
                      >
                        <div className="bg-bg-deep w-16 h-16 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Truck className="w-8 h-8 text-gray-500 group-hover:text-brand-primary" />
                        </div>
                        <div>
                          <p className="text-2xl font-black font-mono text-white tracking-tighter">{eq.tag}</p>
                          <p className="text-[9px] font-bold text-gray-500 uppercase mt-1">{eq.model}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    {/* Header Details */}
                    <div className="bg-bg-section p-8 rounded-2xl border border-brand-primary/20 relative overflow-hidden">
                      <button 
                         onClick={() => setSelectedMappingEquipmentId(null)}
                         className="absolute top-6 right-6 text-[10px] font-black uppercase bg-bg-deep px-4 py-2 rounded hover:text-brand-primary transition-colors border border-border-subtle"
                      >
                        Trocar Equipamento
                      </button>
                      
                      {(() => {
                        const eq = equipment.find(e => e.id === selectedMappingEquipmentId)!;
                        const eqTires = tires.filter(t => t.equipmentId === eq.id);
                        const eqInspections = inspections
                          .filter(i => i.equipmentId === eq.id)
                          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

                        return (
                          <div className="flex flex-col xl:flex-row gap-12">
                            <div className="space-y-8">
                               <div className="flex items-center gap-6">
                                  <div className="bg-brand-primary p-5 rounded-2xl text-black">
                                    <Truck className="w-10 h-10" />
                                  </div>
                                  <div>
                                    <div className="flex items-center gap-3">
                                      <h3 className="text-5xl font-black font-mono tracking-tighter text-white uppercase">{eq.tag}</h3>
                                      <span className={cn(
                                        "text-[8px] font-black px-2 py-0.5 rounded border uppercase tracking-widest",
                                        eq.status === 'in_operation' ? "bg-brand-primary/20 text-brand-primary border-brand-primary/40" :
                                        eq.status === 'in_maintenance' ? "bg-red-500/20 text-red-500 border-red-500/40" :
                                        eq.status === 'idle' ? "bg-gray-500/20 text-gray-400 border-gray-500/40" :
                                        "bg-green-500/20 text-green-500 border-green-500/40"
                                      )}>
                                        {eq.status === 'in_operation' ? 'Em Operação' : 
                                         eq.status === 'in_maintenance' ? 'Em Manutenção' :
                                         eq.status === 'idle' ? 'Ocioso' : 'Ativo'}
                                      </span>
                                    </div>
                                    <p className="text-sm font-bold text-gray-400 uppercase tracking-[0.3em]">{eq.model || 'MODELO NÃO ESPECIFICADO'}</p>
                                  </div>
                               </div>
                               <div className="grid grid-cols-2 gap-4">
                                  <div className="bg-bg-deep p-4 rounded-xl border border-border-subtle">
                                     <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-1">Horímetro Atual</p>
                                     <p className="text-2xl font-mono font-black text-brand-primary">{eq.hourMeter}h</p>
                                  </div>
                                  <div className="bg-bg-deep p-4 rounded-xl border border-border-subtle">
                                     <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-1">Última Inspeção</p>
                                     <p className="text-2xl font-mono font-black text-white">{eqInspections[0] ? new Date(eqInspections[0].date).toLocaleDateString() : 'N/A'}</p>
                                  </div>
                               </div>
                            </div>

                            <div className="flex-1">
                               <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                                  {Array.from({ length: 12 }, (_, i) => (i + 1).toString()).map(pos => {
                                    const tire = eqTires.find(t => t.position === pos);
                                    return (
                                      <div key={pos} className={cn(
                                        "p-4 rounded-xl border relative flex flex-col items-center justify-center gap-1 min-h-[120px]",
                                        tire ? "bg-bg-deep border-border-subtle" : "opacity-10 border-dashed border-gray-700 bg-transparent"
                                      )}>
                                        <span className="text-[10px] font-black text-gray-600 font-mono absolute top-2 left-2">{pos}</span>
                                        {tire ? (
                                          <>
                                            <p className="text-sm font-black font-mono text-white tracking-widest mb-1">{tire.dot}</p>
                                            <div className="flex items-center gap-1 text-[10px] font-black">
                                               <span className={cn(tire.currentTreadDepth < 15 ? "text-red-500" : "text-brand-primary")}>{tire.currentTreadDepth}mm</span>
                                               <span className="text-gray-600 mx-1">|</span>
                                               <span className="text-brand-secondary">{tire.pressure || '--'} PSI</span>
                                            </div>
                                            <span className="text-[7px] font-bold text-gray-500 uppercase mt-2">{tire.brand} • {tire.type === 'new' ? 'NOVO' : 'REFORMADO'}</span>
                                          </>
                                        ) : (
                                          <div className="flex flex-col items-center justify-center text-gray-600 gap-1">
                                             <Package className="w-5 h-5 opacity-20" />
                                             <span className="text-[8px] font-bold uppercase">Disponível</span>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                               </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Timeline / History */}
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-12">
                       <div className="xl:col-span-2 space-y-8">
                          <h4 className="text-xl font-black uppercase tracking-tight text-white flex items-center gap-3">
                            <History className="w-5 h-5 text-brand-primary" />
                            Histórico Recente de Atividades
                          </h4>
                          <div className="space-y-4">
                             {inspections
                               .filter(i => i.equipmentId === selectedMappingEquipmentId)
                               .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                               .slice(0, 8)
                               .map((insp, idx) => {
                                  const tire = tires.find(t => t.id === insp.tireId);
                                  return (
                                    <div key={insp.id} className="bg-bg-section p-6 rounded-xl border border-border-subtle flex items-center justify-between group">
                                       <div className="flex items-center gap-6">
                                          <div className="text-center min-w-[60px]">
                                             <p className="text-[10px] font-black text-gray-500 uppercase">{new Date(insp.date).toLocaleDateString(undefined, { month: 'short' })}</p>
                                             <p className="text-2xl font-mono font-black text-white">{new Date(insp.date).getDate()}</p>
                                          </div>
                                          <div className="w-px h-10 bg-border-subtle" />
                                          <div>
                                             <p className="text-sm font-black text-white flex items-center gap-2">
                                               {insp.condition === 'Montagem/Substituição' ? <Repeat className="w-3 h-3 text-brand-secondary" /> : <ClipboardCheck className="w-3 h-3 text-brand-primary" />}
                                               {insp.condition}
                                             </p>
                                             <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-1">
                                               Pneu: <span className="text-gray-300 font-mono">{tire?.dot || 'N/A'}</span> • {tire?.brand} • {insp.pressure} PSI
                                             </p>
                                          </div>
                                       </div>
                                       <div className="text-right">
                                          <p className="text-xs font-black text-brand-primary font-mono">{insp.treadDepthPoints[0]}mm</p>
                                          <p className="text-[8px] font-bold text-gray-600 uppercase mt-1">H: {insp.equipmentHourMeter}h</p>
                                       </div>
                                       <button 
                                         onClick={(e) => {
                                           e.stopPropagation();
                                           handleDeleteInspection(insp.id);
                                         }}
                                         className="p-1.5 text-gray-500 hover:text-red-500 rounded transition-all opacity-0 group-hover:opacity-100"
                                       >
                                         <Trash2 className="w-3 h-3" />
                                       </button>
                                    </div>
                                  );
                               })
                             }
                             {inspections.filter(i => i.equipmentId === selectedMappingEquipmentId).length === 0 && (
                               <div className="border border-dashed border-gray-800 rounded-xl py-12 text-center text-gray-500">
                                  <p className="text-sm uppercase font-bold tracking-widest italic">Nenhum evento registrado</p>
                               </div>
                             )}
                          </div>
                       </div>
                       
                       <div className="space-y-8">
                          <h4 className="text-xl font-black uppercase tracking-tight text-white flex items-center gap-3">
                            <Zap className="w-5 h-5 text-brand-secondary" />
                            Estatísticas do Ativo
                          </h4>
                          <div className="bg-bg-section p-8 rounded-2xl border border-border-subtle space-y-8">
                             {(() => {
                               const eqTires = tires.filter(t => t.equipmentId === selectedMappingEquipmentId);
                               const avgTwi = eqTires.length > 0 ? (eqTires.reduce((acc, t) => acc + t.currentTreadDepth, 0) / eqTires.length).toFixed(1) : '0';
                               const lowTires = eqTires.filter(t => t.currentTreadDepth < 15).length;
                               
                               return (
                                 <>
                                   <div className="space-y-2">
                                      <div className="flex justify-between items-end">
                                         <p className="text-[10px] font-black text-gray-500 uppercase">Média Geral de Sulco</p>
                                         <p className="text-xs font-black text-white">{avgTwi}mm</p>
                                      </div>
                                      <div className="w-full h-1.5 bg-bg-deep rounded-full overflow-hidden">
                                         <div className="h-full bg-brand-primary" style={{ width: `${Math.min((Number(avgTwi) / 45) * 100, 100)}%` }} />
                                      </div>
                                   </div>

                                   <div className="grid grid-cols-2 gap-6">
                                      <div className="p-4 rounded-xl bg-bg-deep border border-border-subtle">
                                         <p className="text-[8px] font-black text-gray-500 uppercase mb-1">Status Ativos</p>
                                         <p className="text-xl font-mono font-black text-white">{eqTires.length}/12</p>
                                      </div>
                                      <div className={cn("p-4 rounded-xl border", lowTires > 0 ? "bg-red-500/10 border-red-500/30" : "bg-bg-deep border-border-subtle")}>
                                         <p className="text-[8px] font-black text-gray-500 uppercase mb-1">Alertas TWI</p>
                                         <p className={cn("text-xl font-mono font-black", lowTires > 0 ? "text-red-500" : "text-white")}>{lowTires}</p>
                                      </div>
                                   </div>

                                   <button 
                                      onClick={() => { setView('reports'); }}
                                      className="w-full bg-bg-deep border border-border-subtle py-4 rounded-xl text-[10px] font-black uppercase tracking-widest hover:border-brand-primary transition-all flex items-center justify-center gap-3"
                                   >
                                      <Download className="w-4 h-4" />
                                      Gerar Laudo Completo
                                   </button>
                                 </>
                               );
                             })()}
                          </div>
                       </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {view === 'alerts' && (
              <motion.div 
                key="alerts"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="space-y-12"
              >
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1 uppercase text-white flex items-center gap-4">
                      Monitor de Alertas Críticos
                      <span className="bg-red-500/20 text-red-500 text-[10px] px-2 py-1 rounded border border-red-500/30 font-black animate-pulse">LIVE</span>
                    </h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Identificação Proativa de Falhas Potenciais</p>
                  </div>
                  <div className="flex bg-bg-card p-1 rounded-lg border border-border-subtle">
                     <div className="px-6 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400">Scan Total: {tires.length} Pneus</div>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  {/* Alert Column: Low TWI */}
                  <div className="space-y-6">
                    <div className="flex items-center justify-between pb-4 border-b border-red-500/30">
                       <p className="text-xs font-black text-red-500 uppercase tracking-widest flex items-center gap-2">
                        <TrendingDown className="w-4 h-4" /> Desgaste Excessivo (TWI)
                       </p>
                       <span className="bg-red-500 text-black px-2 py-0.5 rounded text-[8px] font-black">TWI &lt; 15mm</span>
                    </div>
                    <div className="space-y-4">
                      {tires.filter(t => t.currentTreadDepth < 15 && t.status === 'in_use').map(t => {
                        const eq = equipment.find(e => e.id === t.equipmentId);
                        return (
                          <div key={t.id} className="bg-red-950/10 border border-red-500/20 p-4 rounded-lg flex items-center justify-between group hover:bg-red-950/20 transition-all cursor-pointer" onClick={() => { setView('inspections'); setActiveEquipmentId(eq?.id || null); setSelectedTireIdForInspection(t.id); }}>
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-red-500/20 rounded flex items-center justify-center text-red-500 border border-red-500/30">
                                <span className="font-mono font-black text-xs">{t.currentTreadDepth}</span>
                              </div>
                              <div>
                                <p className="text-sm font-black text-white font-mono">{t.dot}</p>
                                <p className="text-[10px] font-bold text-gray-500 uppercase">{eq?.tag || 'S/ Tag'} • Pos: {t.position}</p>
                              </div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-red-500 transition-colors" />
                          </div>
                        );
                      })}
                      {tires.filter(t => t.currentTreadDepth < 15 && t.status === 'in_use').length === 0 && (
                        <p className="text-center py-8 text-[10px] font-bold text-gray-600 uppercase italic">Nenhum nível crítico</p>
                      )}
                    </div>
                  </div>

                  {/* Alert Column: Abnormal Pressure */}
                  <div className="space-y-6">
                    <div className="flex items-center justify-between pb-4 border-b border-indigo-500/30">
                       <p className="text-xs font-black text-indigo-400 uppercase tracking-widest flex items-center gap-2">
                        <Zap className="w-4 h-4" /> Pressão Irregular
                       </p>
                       <span className="bg-indigo-500 text-black px-2 py-0.5 rounded text-[8px] font-black">&lt; 90 ou &gt; 120 PSI</span>
                    </div>
                    <div className="space-y-4">
                      {tires.filter(t => (t.pressure < 90 || t.pressure > 120) && t.status === 'in_use').map(t => {
                        const eq = equipment.find(e => e.id === t.equipmentId);
                        return (
                          <div key={t.id} className="bg-indigo-950/10 border border-indigo-500/20 p-4 rounded-lg flex items-center justify-between group hover:bg-indigo-950/20 transition-all cursor-pointer" onClick={() => { setView('inspections'); setActiveEquipmentId(eq?.id || null); setSelectedTireIdForInspection(t.id); }}>
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-indigo-500/20 rounded flex items-center justify-center text-indigo-400 border border-indigo-500/30">
                                <span className="font-mono font-black text-xs">{t.pressure}</span>
                              </div>
                              <div>
                                <p className="text-sm font-black text-white font-mono">{t.dot}</p>
                                <p className="text-[10px] font-bold text-gray-500 uppercase">{eq?.tag || 'S/ Tag'} • Pos: {t.position}</p>
                              </div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-indigo-400 transition-colors" />
                          </div>
                        );
                      })}
                      {tires.filter(t => (t.pressure < 90 || t.pressure > 120) && t.status === 'in_use').length === 0 && (
                        <p className="text-center py-8 text-[10px] font-bold text-gray-600 uppercase italic">Pressão estabilizada</p>
                      )}
                    </div>
                  </div>

                  {/* Alert Column: Inspection Overdue */}
                  <div className="space-y-6">
                    <div className="flex items-center justify-between pb-4 border-b border-amber-500/30">
                       <p className="text-xs font-black text-amber-500 uppercase tracking-widest flex items-center gap-2">
                        <Clock className="w-4 h-4" /> Inspeção Atrasada
                       </p>
                       <span className="bg-amber-500 text-black px-2 py-0.5 rounded text-[8px] font-black">&gt; 30 Dias</span>
                    </div>
                    <div className="space-y-4">
                      {equipment.filter(eq => {
                        const lastInsp = inspections
                          .filter(i => i.equipmentId === eq.id)
                          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                        const thirtyDaysAgo = new Date();
                        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                        return !lastInsp || new Date(lastInsp.date).getTime() < thirtyDaysAgo.getTime();
                      }).map(eq => {
                        return (
                          <div key={eq.id} className="bg-amber-950/10 border border-amber-500/20 p-4 rounded-lg flex items-center justify-between group hover:bg-amber-950/20 transition-all cursor-pointer" onClick={() => { setView('inspections'); setActiveEquipmentId(eq.id); }}>
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-amber-500/20 rounded flex items-center justify-center text-amber-500 border border-amber-500/30">
                                <Truck className="w-5 h-5" />
                              </div>
                              <div>
                                <p className="text-sm font-black text-white font-mono tracking-tighter">{eq.tag}</p>
                                <p className="text-[10px] font-bold text-gray-500 uppercase">Última: {inspections.filter(i => i.equipmentId === eq.id).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]?.date ? new Date(inspections.filter(i => i.equipmentId === eq.id).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0].date).toLocaleDateString() : 'Nunca'}</p>
                              </div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-amber-500 transition-colors" />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Critical Equipment Visual List */}
                <div className="pt-12 border-t border-border-subtle">
                  <h3 className="text-xl font-black uppercase tracking-tight text-white mb-8">Raio-X de Ativos em Alerta</h3>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                    {equipment.filter(eq => {
                      const eqTires = tires.filter(t => t.equipmentId === eq.id);
                      return eqTires.some(t => t.currentTreadDepth < 15 || t.pressure < 90 || t.pressure > 120);
                    }).map(eq => {
                      const eqTires = tires.filter(t => t.equipmentId === eq.id);
                      return (
                        <div key={eq.id} className="bg-bg-section p-6 rounded-xl border border-red-500/20 flex flex-col gap-6">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className="bg-red-500/10 p-3 rounded border border-red-500/20">
                                <Truck className="w-6 h-6 text-red-500" />
                              </div>
                              <div>
                                <h4 className="text-2xl font-black font-mono text-white">{eq.tag}</h4>
                                <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">{eq.model}</p>
                              </div>
                            </div>
                            <button onClick={() => { setView('fleet-status'); }} className="text-[9px] font-black uppercase tracking-widest text-brand-primary border-b border-brand-primary/30 hover:border-brand-primary transition-all">Ver Detalhes</button>
                          </div>
                          <div className="grid grid-cols-6 gap-2">
                             {Array.from({ length: 12 }, (_, i) => (i + 1).toString()).map(pos => {
                               const tire = eqTires.find(t => t.position === pos);
                               const isCritical = tire && (tire.currentTreadDepth < 15 || tire.pressure < 90 || tire.pressure > 120);
                               return (
                                 <div key={pos} className={cn(
                                   "aspect-square rounded border flex flex-col items-center justify-center p-1",
                                   isCritical ? "bg-red-500/20 border-red-500/50" : tire ? "bg-bg-deep border-border-subtle" : "opacity-10 border-dashed border-gray-700"
                                 )}>
                                   <span className="text-[7px] font-black text-gray-500 uppercase">{pos}</span>
                                   {tire && <span className={cn("text-[9px] font-black font-mono", isCritical ? "text-red-500" : "text-brand-primary")}>{tire.currentTreadDepth}</span>}
                                 </div>
                               );
                             })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}
            {view === 'fleet-status' && (
              <motion.div 
                key="fleet-status"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-12"
              >
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1 uppercase text-white">Status em Tempo Real da Frota</h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Resumo Operacional detalhado por Ativo</p>
                  </div>
                  <div className="flex bg-bg-card p-1 rounded-lg border border-border-subtle">
                    <button onClick={() => setView('equipment')} className="px-6 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-white transition-all">Editar Frota</button>
                    <button className="px-6 py-2 text-[10px] font-black uppercase tracking-widest bg-brand-primary text-black rounded shadow-lg">Visão Resumo</button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-8">
                  {equipment.map(eq => {
                    const eqTires = tires.filter(t => t.equipmentId === eq.id);
                    const lastInspection = inspections
                      .filter(i => i.equipmentId === eq.id)
                      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                    
                    const lastReplacement = inspections
                      .filter(i => i.equipmentId === eq.id && (i.condition === 'Montagem/Substituição' || i.condition === 'Montagem Inicial'))
                      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];

                    const avgPressure = eqTires.length > 0 
                      ? (eqTires.reduce((acc, t) => acc + (t.pressure || 0), 0) / eqTires.length).toFixed(0)
                      : '0';

                    const newCount = eqTires.filter(t => t.type === 'new').length;
                    const rCount = eqTires.filter(t => t.type === 'retreaded').length;
                    
                    return (
                      <div key={eq.id} className="bg-bg-section p-8 rounded-xl border border-border-subtle shadow-xl hover:border-brand-primary/30 transition-all group overflow-hidden relative">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-brand-primary/5 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none group-hover:bg-brand-primary/10 transition-all" />
                        
                        <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-12 mb-12 pb-8 border-b border-border-subtle relative">
                          <div className="flex items-center gap-8">
                            <div className="bg-gradient-to-br from-brand-primary to-yellow-600 w-24 h-24 rounded-2xl flex items-center justify-center text-black shadow-2xl shadow-brand-primary/20 transform group-hover:scale-105 transition-transform">
                              <Truck className="w-12 h-12" />
                            </div>
                            <div>
                              <div className="flex items-center gap-3 mb-1">
                                <h3 className="text-5xl font-black font-mono tracking-tighter text-white uppercase">{eq.tag}</h3>
                                <div className="flex items-center gap-2">
                                  <span className={cn(
                                    "text-[8px] font-black px-2 py-0.5 rounded border uppercase tracking-widest",
                                    eq.status === 'in_operation' ? "bg-brand-primary/10 text-brand-primary border-brand-primary/20" :
                                    eq.status === 'in_maintenance' ? "bg-red-500/10 text-red-500 border-red-500/20" :
                                    eq.status === 'idle' ? "bg-gray-500/10 text-gray-400 border-gray-500/20" :
                                    "bg-green-500/10 text-green-500 border-green-500/20"
                                  )}>
                                    {eq.status === 'in_operation' ? 'Em Operação' : 
                                     eq.status === 'in_maintenance' ? 'Em Manutenção' :
                                     eq.status === 'idle' ? 'Ocioso' : 'Ativo'}
                                  </span>
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDiscardEquipment(eq.id);
                                    }}
                                    className="p-1 text-gray-500 hover:text-red-500 hover:bg-red-500/10 rounded transition-all ml-2"
                                    title="Descartar Equipamento"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                              <p className="text-sm font-bold text-gray-500 uppercase tracking-widest flex items-center gap-3">
                                {eq.model} <span className="w-1.5 h-1.5 rounded-full bg-gray-700" /> {eq.unitName || 'Unidade Principal'}
                              </p>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-12 flex-1 max-w-4xl">
                             <div className="space-y-1">
                                <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">Horímetro Atual</p>
                                <p className="text-3xl font-mono font-black text-brand-primary tracking-tighter">{eq.hourMeter}<span className="text-[10px] ml-1">h</span></p>
                             </div>
                             <div className="space-y-1">
                                <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">H. Última Troca</p>
                                <p className="text-3xl font-mono font-black text-white tracking-tighter">
                                  {lastReplacement?.equipmentHourMeter || 'N/A'}<span className="text-[10px] ml-1">h</span>
                                </p>
                             </div>
                             <div className="space-y-1">
                                <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">Pressão Média</p>
                                <p className="text-3xl font-mono font-black text-brand-secondary tracking-tighter">{avgPressure}<span className="text-[10px] ml-1">PSI</span></p>
                             </div>
                             <div className="space-y-1">
                                <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">TWI Médio</p>
                                <p className="text-3xl font-mono font-black text-white tracking-tighter">
                                  {eqTires.length > 0 ? (eqTires.reduce((acc, t) => acc + t.currentTreadDepth, 0) / eqTires.length).toFixed(1) : '0'}<span className="text-[10px] ml-1">mm</span>
                                </p>
                             </div>
                             <div className="space-y-1">
                                <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">Último Check</p>
                                <p className="text-3xl font-mono font-black text-white tracking-tighter">
                                  {lastInspection ? new Date(lastInspection.date).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }) : 'N/A'}
                                </p>
                             </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 xl:grid-cols-12 gap-4 relative">
                          {Array.from({ length: 12 }, (_, i) => (i + 1).toString()).map(pos => {
                            const tire = eqTires.find(t => t.position === pos);
                            const healthColor = tire 
                              ? (tire.currentTreadDepth < 15 ? 'bg-red-500' : tire.currentTreadDepth < 25 ? 'bg-orange-500' : 'bg-brand-primary')
                              : 'bg-gray-800';

                            return (
                              <div key={pos} className={cn(
                                "p-4 rounded-xl border flex flex-col items-center justify-center gap-2 aspect-square transition-all",
                                tire ? "bg-bg-deep border-border-subtle hover:border-brand-primary/50 cursor-default" : "bg-bg-deep opacity-10 border-dashed border-gray-700"
                              )}>
                                <div className="flex items-center justify-between w-full mb-1">
                                  <span className="text-[10px] font-black text-gray-500 uppercase font-mono">{pos}</span>
                                  {tire && (
                                    <div className={cn("w-1.5 h-1.5 rounded-full", healthColor)} />
                                  )}
                                </div>
                                
                                {tire ? (
                                  <>
                                    <div className="text-center">
                                      <p className={cn("text-lg font-black font-mono leading-none", tire.currentTreadDepth < 15 ? "text-red-500" : "text-white")}>{tire.currentTreadDepth}<span className="text-[8px] ml-0.5 uppercase tracking-tighter opacity-60">mm</span></p>
                                      <p className="text-[9px] font-bold text-gray-500 mt-1 uppercase opacity-60">{tire.pressure || '--'} PSI</p>
                                    </div>
                                    <div className="flex gap-1 mt-1">
                                      <span className={cn("text-[7px] font-black uppercase px-2 py-0.5 rounded-full bg-white/5", tire.type === 'new' ? "text-blue-400" : "text-brand-secondary")}>
                                        {tire.type === 'new' ? 'NOVO' : 'REFORM'}
                                      </span>
                                    </div>
                                  </>
                                ) : (
                                  <div className="flex flex-col items-center opacity-30">
                                    <Package className="w-4 h-4 mb-1" />
                                    <span className="text-[8px] font-bold uppercase">Livre</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="mt-8 pt-6 border-t border-border-subtle flex flex-wrap items-center gap-8">
                           <div className="flex items-center gap-3">
                              <div className="flex -space-x-2">
                                {Array.from({ length: Math.min(newCount, 4) }).map((_, i) => (
                                  <div key={i} className="w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center">
                                    <span className="text-[6px] font-black text-blue-500">N</span>
                                  </div>
                                ))}
                                {newCount > 4 && <div className="w-5 h-5 rounded-full bg-bg-card border border-border-subtle flex items-center justify-center text-[6px] font-black">+{newCount-4}</div>}
                              </div>
                              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Pneus Novos: {newCount}</p>
                           </div>
                           <div className="flex items-center gap-3">
                              <div className="flex -space-x-2">
                                {Array.from({ length: Math.min(rCount, 4) }).map((_, i) => (
                                  <div key={i} className="w-5 h-5 rounded-full bg-brand-secondary/20 border border-brand-secondary/30 flex items-center justify-center">
                                    <span className="text-[6px] font-black text-brand-secondary">R</span>
                                  </div>
                                ))}
                                {rCount > 4 && <div className="w-5 h-5 rounded-full bg-bg-card border border-border-subtle flex items-center justify-center text-[6px] font-black">+{rCount-4}</div>}
                              </div>
                              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Reformados: {rCount}</p>
                           </div>
                           <div className="flex items-center gap-3 ml-auto opacity-40 hover:opacity-100 transition-opacity cursor-pointer">
                              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Último Relatório Completo</p>
                              <ArrowRight className="w-4 h-4" />
                           </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {view === 'equipment' && (
              <motion.div 
                key="equipment"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="grid grid-cols-1 lg:grid-cols-2 gap-12"
              >
                <div className="space-y-10">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1">Frota Ativa</h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Posicionamento e Telemetria</p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {equipment.map(eq => {
                      const eqTires = tires.filter(t => t.equipmentId === eq.id);
                      const isCritical = eqTires.some(t => t.currentTreadDepth < 10);
                      return (
                        <div key={eq.id} className="relative group">
                          <button 
                            onClick={() => setActiveEquipmentId(eq.id)}
                            className={cn(
                              "w-full bg-bg-section border p-6 rounded-lg flex items-center gap-5 hover:bg-bg-card transition-all text-left",
                              isCritical ? "border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.1)]" : "border-border-subtle hover:border-brand-primary"
                            )}
                          >
                            <div className={cn(
                              "bg-bg-deep p-4 rounded border group-hover:border-brand-primary/30",
                              isCritical ? "border-red-500/30" : "border-border-subtle"
                            )}>
                              <Truck className={cn("w-8 h-8", isCritical ? "text-red-500" : "text-gray-600 group-hover:text-brand-primary")} />
                            </div>
                            <div className="flex-1">
                              <p className={cn("font-mono text-xl font-bold tracking-tight", isCritical ? "text-red-500" : "text-brand-primary")}>{eq.tag}</p>
                              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{eq.model} • {eq.hourMeter}H</p>
                            </div>
                            {isCritical && (
                              <div className="flex flex-col items-end">
                                <AlertTriangle className="w-4 h-4 text-red-500 animate-pulse" />
                                <span className="text-[8px] font-bold text-red-500 uppercase">TWI Baixo</span>
                              </div>
                            )}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDiscardEquipment(eq.id);
                            }}
                            className="absolute top-2 right-2 p-1.5 text-gray-700 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100 bg-bg-deep/50 rounded-md backdrop-blur-sm"
                            title="Remover Equipamento"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                    <button 
                      onClick={() => setIsRegisterEquipmentModalOpen(true)}
                      className="col-span-full mt-4 border-2 border-dashed border-border-subtle rounded-lg py-8 flex items-center justify-center gap-3 text-gray-500 hover:text-brand-primary hover:border-brand-primary transition-all group"
                    >
                      <Plus className="w-5 h-5 group-hover:scale-110 transition-transform" />
                      <span className="font-bold text-xs uppercase tracking-widest">Novo Equipamento via Assistente</span>
                    </button>
                  </div>
                </div>

                {activeEquipmentId || equipment.length > 0 ? (
                  <div className="bg-bg-section p-10 rounded-lg border border-border-subtle shadow-sm sticky top-12 h-fit">
                    {(() => {
                      const selectedEq = equipment.find(e => e.id === (activeEquipmentId || equipment[0].id)) || equipment[0];
                      const eqTires = tires.filter(t => t.equipmentId === selectedEq.id);
                      return (
                        <>
                          <div className="flex items-center justify-between mb-10">
                             <div className="flex flex-col gap-1">
                                <h3 className="text-xl font-bold tracking-tight uppercase">Equipamento: <span className="text-brand-primary">{selectedEq.tag}</span></h3>
                                <p className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">{selectedEq.model} • {selectedEq.site}</p>
                             </div>
                             <div className="flex items-center gap-3">
                                <div className="flex items-center gap-2 bg-brand-secondary/20 text-brand-secondary px-3 py-1 rounded border border-brand-secondary/30">
                                   <div className="w-2 h-2 bg-brand-secondary rounded-full animate-pulse" />
                                   <span className="text-[9px] font-bold uppercase tracking-widest">Ativo</span>
                                </div>
                                <button 
                                  onClick={() => {
                                    setNewEquipment({
                                      id: selectedEq.id,
                                      tag: selectedEq.tag,
                                      model: selectedEq.model,
                                      hourMeter: selectedEq.hourMeter,
                                      registrationDate: selectedEq.registrationDate || new Date().toISOString().split('T')[0],
                                      status: selectedEq.status || 'in_operation',
                                      selectedPosition: '1',
                                      tires: Array.from({ length: 12 }, (_, i) => {
                                        const pos = (i + 1).toString();
                                        const tire = eqTires.find(t => t.position === pos);
                                        return {
                                          position: pos,
                                          dot: tire?.batchName || tire?.dot || '',
                                          brand: tire?.brand || '',
                                          type: tire?.type === 'retreaded' ? 'retreaded' : 'new' as any,
                                          treadDepth: tire?.currentTreadDepth || 45,
                                          pressure: tire?.pressure || 105
                                        };
                                      })
                                    });
                                    setIsRegisterEquipmentModalOpen(true);
                                  }}
                                  className="p-2 text-brand-primary hover:bg-brand-primary/10 border border-brand-primary/20 rounded-md transition-all group"
                                  title="Editar Parâmetros"
                                >
                                  <Settings className="w-4 h-4 group-hover:rotate-45 transition-transform" />
                                </button>
                             </div>
                          </div>
                          <TruckLayout 
                            equipment={selectedEq} 
                            tires={eqTires} 
                          />
                          <div className="mt-10 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                              <div className="bg-bg-deep p-6 rounded border border-border-subtle">
                                 <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Horas Totais</p>
                                 <p className="font-mono text-2xl font-bold text-white">{selectedEq.hourMeter}h</p>
                              </div>
                              <div className="bg-bg-deep p-6 rounded border border-border-subtle">
                                 <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Local/Mina</p>
                                 <p className="font-mono text-2xl font-bold text-white leading-tight">{selectedEq.site}</p>
                              </div>
                            </div>
                            {eqTires.some(t => t.currentTreadDepth < 10) && (
                              <div className="p-6 bg-red-900/20 border border-red-500/30 rounded-lg flex items-center gap-4">
                                <AlertTriangle className="w-10 h-10 text-red-500" />
                                <div className="flex-1">
                                  <p className="font-bold text-red-100 uppercase text-xs">Substituição Urgente Detectada</p>
                                  <p className="text-[10px] text-red-400 font-bold uppercase tracking-widest">{eqTires.filter(t => t.currentTreadDepth < 10).length} pneus com sulco residual &lt; 10mm</p>
                                </div>
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : null}
              </motion.div>
            )}

            {view === 'inventory' && (
              <motion.div 
                key="inventory"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-8"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-6 border-b border-border-subtle">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1 flex items-center gap-3">
                      <Database className="w-8 h-8 text-brand-primary" />
                      Controle de Ativos
                    </h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest px-11">Gestão de Inventário por Lotes</p>
                  </div>
                  <button 
                    onClick={() => setIsRegisterTireModalOpen(true)}
                    className="bg-brand-secondary text-white px-8 py-3 rounded font-black text-xs hover:brightness-110 transition-all uppercase tracking-widest shadow-[0_0_15px_rgba(34,197,94,0.2)] flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Cadastrar Novo Lote
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {(() => {
                    // Grouping by Batch Name first, then Date if key is missing
                    const batchesMap = tires.reduce((acc, tire) => {
                      const key = tire.batchName || tire.arrivalDate || 'Sem Identificação';
                      if (!acc[key]) acc[key] = [];
                      acc[key].push(tire);
                      return acc;
                    }, {} as Record<string, Tire[]>);

                    return Object.entries(batchesMap).sort((a,b) => b[0].localeCompare(a[0])).map(([batchKey, batchTires]) => {
                      const tiresList = batchTires as Tire[];
                      const avgWear = tiresList.reduce((sum, t) => sum + (t.currentTreadDepth / t.initialTreadDepth), 0) / tiresList.length;
                      const date = tiresList[0]?.arrivalDate || '---';

                      return (
                        <motion.div 
                          key={batchKey} 
                          layout
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="bg-bg-section rounded-xl border border-border-subtle overflow-hidden flex flex-col shadow-lg"
                        >
                          <div className="p-6 bg-bg-deep/50 border-b border-border-subtle flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 rounded bg-brand-primary/10 flex items-center justify-center border border-brand-primary/20 text-brand-primary">
                                <Package className="w-5 h-5" />
                              </div>
                              <div>
                                <h3 className="text-sm font-black uppercase tracking-tight text-white">{batchKey}</h3>
                                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Recebido em: {date}</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Estado Médio</p>
                              <div className="flex items-center gap-2 mt-1">
                                <div className="w-24 h-1.5 bg-bg-deep rounded-full overflow-hidden border border-border-subtle">
                                  <div 
                                    className={cn(
                                      "h-full transition-all duration-1000",
                                      avgWear > 0.7 ? "bg-brand-secondary" : avgWear > 0.4 ? "bg-amber-500" : "bg-red-500"
                                    )} 
                                    style={{ width: `${avgWear * 100}%` }} 
                                  />
                                </div>
                                <span className="text-[10px] font-mono font-bold text-brand-primary">{Math.round(avgWear * 100)}%</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex-1 overflow-x-auto">
                            <table className="w-full text-left border-collapse min-w-[500px]">
                              <thead>
                                <tr className="bg-bg-deep/30 text-[9px] font-bold text-gray-500 uppercase tracking-widest border-b border-border-subtle">
                                  <th className="px-6 py-4">DOT / Ident</th>
                                  <th className="px-6 py-4">Marca/Status</th>
                                  <th className="px-6 py-4">Sulco</th>
                                  <th className="px-6 py-4 text-right">Ações</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border-subtle text-white">
                                {tiresList.map(t => (
                                  <tr 
                                    key={t.id} 
                                    className="hover:bg-brand-primary/5 transition-all cursor-pointer group"
                                    onClick={() => {
                                      setSelectedTireToEdit(t);
                                      setIsEditTireModalOpen(true);
                                    }}
                                  >
                                    <td className="px-6 py-4">
                                      <div className="flex flex-col">
                                        <span className="font-mono font-bold text-brand-primary text-xs">{t.dot}</span>
                                        <span className="text-[9px] text-gray-400 font-bold uppercase">{t.type === 'new' ? 'Novo' : 'Reformado'}</span>
                                      </div>
                                    </td>
                                    <td className="px-6 py-4">
                                      <p className="text-[10px] font-bold text-white uppercase">{t.brand}</p>
                                      <span className={cn(
                                        "text-[8px] font-black uppercase px-1.5 py-0.5 rounded border tracking-tighter mt-1 inline-block",
                                        t.status === 'in_use' ? "bg-amber-900/20 text-amber-500 border-amber-500/30" :
                                        t.status === 'inventory' ? "bg-brand-secondary/20 text-brand-secondary border-brand-secondary/30" :
                                        t.status === 'scrapped' ? "bg-red-900/20 text-red-500 border-red-500/30" :
                                        "bg-blue-900/20 text-blue-400 border-blue-400/30"
                                      )}>
                                        {t.status === 'in_use' ? "EM USO" : t.status === 'inventory' ? "ESTOQUE" : t.status.replace('_', ' ').toUpperCase()}
                                      </span>
                                    </td>
                                    <td className="px-6 py-4">
                                      <div className="flex items-center gap-2">
                                        <div className="w-10 h-1 bg-bg-deep rounded-full overflow-hidden border border-border-subtle">
                                           <div className="h-full bg-brand-primary" style={{ width: `${(t.currentTreadDepth / t.initialTreadDepth) * 100}%` }} />
                                        </div>
                                        <span className="text-[10px] font-mono text-white">{t.currentTreadDepth}mm</span>
                                      </div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                      <div className="flex items-center justify-end gap-1">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteTire(t.id, t.dot);
                                          }}
                                          className="p-1.5 text-gray-500 hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                                          title="Excluir"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          
                          <div className="p-4 bg-bg-deep/20 flex justify-between items-center text-[10px] font-bold text-gray-500 uppercase tracking-widest border-t border-border-subtle">
                             <span>Total: {tiresList.length}</span>
                             <span className="text-brand-primary">Disponível: {tiresList.filter(t => t.status === 'inventory').length}</span>
                          </div>
                        </motion.div>
                      );
                    });
                  })()}
                </div>
              </motion.div>
            )}

            {view === 'inspections' && (
              <motion.div 
                key="inspections"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="space-y-12"
              >
                <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1 uppercase text-white">Inspeções de Campo</h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Coleta de Dados e Telemetria</p>
                  </div>
                  <div className="flex gap-2 bg-bg-section p-1 rounded border border-border-subtle shadow-sm overflow-hidden">
                     <button 
                       onClick={() => setInspectionMode('inspect')}
                       className={cn("px-8 py-3 text-[9px] font-black uppercase rounded transition-all", inspectionMode === 'inspect' ? "bg-brand-primary text-black" : "text-gray-500 hover:text-white")}
                     >
                       Modo Inspeção
                     </button>
                     <button 
                       onClick={() => setInspectionMode('rotate')}
                       className={cn("px-8 py-3 text-[9px] font-black uppercase rounded transition-all", inspectionMode === 'rotate' ? "bg-brand-secondary text-white" : "text-gray-500 hover:text-white")}
                     >
                       Modo Rodízio
                     </button>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 mt-8">
                  <div className="lg:col-span-4 bg-bg-section p-8 rounded-lg border border-border-subtle shadow-sm flex flex-col gap-8">
                    <div className="flex items-center justify-between border-l-2 border-brand-primary pl-4">
                      <h3 className="text-[10px] font-black uppercase text-brand-primary tracking-widest">Ativos para Inspeção</h3>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-brand-primary animate-pulse" />
                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">{equipment.length} Ativos</span>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[70vh] overflow-y-auto pr-2 custom-scrollbar">
                    {equipment.map(eq => {
                      const isActive = activeEquipmentId === eq.id;
                      return (
                        <button 
                          key={eq.id}
                          onClick={() => { setActiveEquipmentId(eq.id); setSelectedTireIdForInspection(null); }}
                          className={cn(
                            "bg-bg-section border p-6 rounded-lg flex items-center gap-5 hover:bg-bg-card transition-all text-left",
                            isActive ? "border-brand-primary bg-brand-primary/5" : "border-border-subtle"
                          )}
                        >
                          <div className={cn("bg-bg-deep p-4 rounded border", isActive ? "bg-brand-primary border-brand-primary" : "border-border-subtle")}>
                            <Truck className="w-6 h-6" />
                          </div>
                          <div>
                            <p className="font-mono text-xl font-bold uppercase">{eq.tag}</p>
                            <p className="text-[10px] font-bold text-gray-500 uppercase">{eq.model}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="lg:col-span-8">
                    {activeEquipmentId && (
                      <div className="bg-bg-section p-10 rounded-lg border border-border-subtle shadow-sm flex flex-col gap-8 h-fit sticky top-12">
                        <div className="flex items-center justify-between border-l-2 border-brand-primary pl-4">
                           <h3 className="text-xl font-bold uppercase tracking-tight text-white">Ativo: <span className="text-brand-primary">{equipment.find(e => e.id === activeEquipmentId)?.tag}</span></h3>
                        </div>
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
                           <div className="flex items-center justify-center p-8 bg-bg-deep rounded-lg border border-border-subtle relative h-[480px]">
                              <div className="relative w-full h-full flex flex-col items-center justify-between z-10 py-2">
                                 {[[1, 2], [3, 4], [5, 6, 7, 8], [9, 10, 11, 12]].map((group, idx) => (
                                   <div key={idx} className={cn("flex justify-between w-full uppercase font-mono text-[8px] text-gray-700 font-bold", group.length > 2 ? "max-w-[300px]" : "max-w-[200px]")}>
                                     {group.map(p => {
                                       const pStr = p.toString();
                                       const tire = tires.find(t => t.equipmentId === activeEquipmentId && t.position === pStr);
                                       return (
                                          <TireAnchor 
                                            key={pStr} 
                                            pos={pStr} 
                                            isActive={selectedTireIdForInspection === tire?.id && !!tire} 
                                            isConfigured={!!tire} 
                                            onClick={() => {
                                              if (inspectionMode === 'rotate' && selectedTireIdForInspection && selectedTireIdForInspection !== tire?.id) {
                                                handleApplyRotation(selectedTireIdForInspection, pStr);
                                              } else {
                                                tire ? setSelectedTireIdForInspection(tire.id) : null;
                                              }
                                            }} 
                                            className={cn(!tire && "opacity-10 border-dashed")} 
                                          />
                                       );
                                     })}
                                   </div>
                                 ))}
                              </div>
                           </div>

                           <div className="space-y-6">
                             {selectedTireIdForInspection ? (
                               <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                                  {(() => {
                                    const tire = tires.find(t => t.id === selectedTireIdForInspection);
                                    if (!tire) return null;
                                    const isLowTwi = tire.currentTreadDepth < 15;
                                    const isIrregularPressure = tire.pressure < 90 || tire.pressure > 120;
                                    
                                    return (
                                      <div className="bg-bg-deep p-6 rounded-xl border border-border-subtle relative overflow-hidden group">
                                        <div className={cn("absolute top-0 right-0 w-24 h-24 blur-3xl -mr-12 -mt-12 opacity-20 transition-all", isLowTwi || isIrregularPressure ? "bg-red-500" : "bg-brand-primary")} />
                                        
                                        <div className="flex justify-between items-start relative z-10">
                                          <div>
                                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.2em] mb-1">Pneu Selecionado</p>
                                            <p className="text-3xl font-mono font-black text-white tracking-tighter">{tire.dot}</p>
                                            <p className="text-[10px] font-bold text-gray-400 uppercase mt-1 tracking-widest">{tire.brand} • {tire.type === 'new' ? 'NOVO' : 'REFORMADO'}</p>
                                          </div>
                                          <div className="text-right">
                                            <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest">Posição</p>
                                            <p className="text-3xl font-mono font-black text-brand-primary">{tire.position}</p>
                                          </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4 mt-8 pt-6 border-t border-white/5 relative z-10">
                                          <div className="space-y-1">
                                            <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">TWI Atual</p>
                                            <p className={cn("text-2xl font-mono font-black tracking-tighter", isLowTwi ? "text-red-500 animate-pulse" : "text-white")}>
                                              {tire.currentTreadDepth}mm
                                            </p>
                                            {isLowTwi && <span className="text-[8px] font-black text-red-500 uppercase tracking-widest">Nível Crítico</span>}
                                          </div>
                                          <div className="space-y-1">
                                            <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-none">Pressão Atual</p>
                                            <p className={cn("text-2xl font-mono font-black tracking-tighter", isIrregularPressure ? "text-red-500" : "text-white")}>
                                              {tire.pressure || '--'} PSI
                                            </p>
                                            {isIrregularPressure && <span className="text-[8px] font-black text-red-500 uppercase tracking-widest">Fora da Faixa</span>}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })()}

                                  {inspectionMode === 'rotate' && (
                                     <div className="bg-bg-card p-6 rounded-lg border border-brand-secondary/20 flex flex-col gap-4">
                                       <div className="flex items-center justify-between">
                                          <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.2em]">Ações de Rodízio</p>
                                          <Repeat className="w-4 h-4 text-brand-secondary" />
                                       </div>
                                       <button 
                                         onClick={() => {
                                           const tire = tires.find(t => t.equipmentId === activeEquipmentId && t.position === selectedTireIdForInspection);
                                           setReplacementPosition(selectedTireIdForInspection);
                                           setIsReplacementModalOpen(true);
                                         }}
                                         className="w-full bg-brand-secondary text-white font-black py-4 rounded-xl uppercase tracking-[0.2em] text-[10px] hover:brightness-110 transition-all flex items-center justify-center gap-3 shadow-xl shadow-brand-secondary/10"
                                       >
                                         <Plus className="w-4 h-4" />
                                         Substituir Pneu
                                       </button>
                                       <p className="text-[8px] text-gray-600 font-medium uppercase tracking-widest text-center italic">Arraste para outra posição para rodízio ou use substituir para troca total</p>
                                     </div>
                                   )}

                                  <div className="space-y-4">
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest">Sulco Atual (mm)</label>
                                     <div className="grid grid-cols-4 gap-2">
                                        {[10, 15, 20, 25, 30, 35, 40, 45].map(val => (
                                          <button 
                                            key={val} 
                                            onClick={() => setInspectionValues({...inspectionValues, twi: val})}
                                            className={cn("py-4 bg-bg-deep border rounded-md font-mono font-black text-sm transition-all", inspectionValues.twi === val ? "border-brand-primary text-brand-primary bg-brand-primary/5" : "border-border-subtle hover:border-gray-600")}
                                          >
                                            {val}
                                          </button>
                                        ))}
                                     </div>

                                     <div className="mt-2">
                                        <p className="text-[8px] text-gray-500 uppercase font-black tracking-widest mb-1">Ajuste Manual TWI (mm)</p>
                                        <input 
                                          type="number"
                                          value={inspectionValues.twi}
                                          onChange={(e) => setInspectionValues({...inspectionValues, twi: Number(e.target.value)})}
                                          className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-brand-primary focus:border-brand-primary outline-none transition-all"
                                        />
                                     </div>

                                     <div className="grid grid-cols-2 gap-4 mt-8">
                                        <div className="space-y-2">
                                          <label className="text-[8px] text-gray-500 uppercase font-black tracking-widest block">Pressão Entrada (PSI)</label>
                                          <input 
                                            type="number" 
                                            value={inspectionValues.psi}
                                            onChange={(e) => setInspectionValues({...inspectionValues, psi: Number(e.target.value)})}
                                            className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-4 font-mono text-xl text-brand-secondary focus:border-brand-secondary outline-none transition-all"
                                          />
                                        </div>
                                        <div className="space-y-2">
                                          <label className="text-[8px] text-gray-500 uppercase font-black tracking-widest block">Pressão Saída (PSI)</label>
                                          <input 
                                            type="number" 
                                            value={inspectionValues.psiAfter}
                                            onChange={(e) => setInspectionValues({...inspectionValues, psiAfter: Number(e.target.value)})}
                                            className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-4 font-mono text-xl text-brand-primary focus:border-brand-primary outline-none transition-all"
                                          />
                                        </div>
                                     </div>

                                     <button 
                                       onClick={handleSaveInspection}
                                       className="w-full bg-brand-primary text-black font-black py-5 rounded-xl uppercase tracking-[0.2em] text-xs hover:brightness-110 transition-all mt-6 shadow-xl shadow-brand-primary/10 flex items-center justify-center gap-3 group"
                                     >
                                       <Save className="w-5 h-5 transition-transform group-hover:rotate-12" />
                                       Salvar Registro
                                     </button>
                                  </div>
                               </div>
                             ) : (
                               <div className="h-full flex flex-col items-center justify-center text-gray-700 opacity-40 border border-dashed border-border-subtle rounded-xl py-20 bg-bg-deep/30">
                                  <ClipboardCheck className="w-16 h-16 mb-6 text-brand-primary/30" />
                                  <div className="text-center space-y-2 max-w-[200px]">
                                     <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white">Mapeamento</p>
                                     <p className="text-[9px] font-medium uppercase tracking-widest leading-relaxed text-gray-400">Selecione uma posição no diagrama para iniciar a medição</p>
                                  </div>
                               </div>
                             )}
                           </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
            {view === 'reports' && (
              <motion.div 
                key="reports"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-12"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-bg-section p-10 rounded-lg border border-border-subtle">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-1">Central de Relatórios</h2>
                    <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Análise de Desempenho e Balanço de Ativos</p>
                  </div>
                  <div className="flex gap-4">
                    <button 
                      onClick={() => generateGeneralReportPDF(tires, equipment)}
                      className="bg-brand-primary text-black px-8 py-3 rounded font-black text-xs hover:brightness-110 transition-all uppercase tracking-widest shadow-[0_0_15px_rgba(226,232,240,0.2)]"
                    >
                      Relatório Geral PDF
                    </button>
                    <button 
                      onClick={() => generateMonthlyBalancePDF(tires)}
                      className="bg-brand-secondary text-white px-8 py-3 rounded font-black text-xs hover:brightness-110 transition-all uppercase tracking-widest shadow-[0_0_15px_rgba(34,197,94,0.2)]"
                    >
                      Balanço Mensal PDF
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                   <div className="bg-bg-section p-8 rounded-lg border border-border-subtle">
                      <h3 className="text-[10px] font-black uppercase text-gray-500 tracking-widest mb-6">Composição do Estoque</h3>
                      <div className="h-[250px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={[
                                { name: 'Novos', value: tires.filter(t => t.type === 'new').length },
                                { name: 'Reformados', value: tires.filter(t => t.type === 'retreaded').length }
                              ]}
                              innerRadius={60}
                              outerRadius={80}
                              paddingAngle={5}
                              dataKey="value"
                            >
                              <Cell fill="#cbd5e1" />
                              <Cell fill="#22c55e" />
                            </Pie>
                            <RechartsTooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="mt-4 flex justify-around text-[10px] font-bold uppercase">
                         <div className="flex items-center gap-2">
                            <div className="w-3 h-3 bg-brand-primary rounded-full" />
                            <span>Novos: {tires.filter(t => t.type === 'new').length}</span>
                         </div>
                         <div className="flex items-center gap-2">
                            <div className="w-3 h-3 bg-brand-secondary rounded-full" />
                            <span>Reformados: {tires.filter(t => t.type === 'retreaded').length}</span>
                         </div>
                      </div>
                   </div>

                   <div className="lg:col-span-2 bg-bg-section p-8 rounded-lg border border-border-subtle">
                      <h3 className="text-[10px] font-black uppercase text-gray-500 tracking-widest mb-6">Top 5 - Vida Útil Projetada (Pneus em Uso)</h3>
                      <div className="space-y-4">
                        {tires.filter(t => t.status === 'in_use' && t.currentHours > 0).sort((a, b) => {
                          const wearA = a.initialTreadDepth - a.currentTreadDepth;
                          const wearB = b.initialTreadDepth - b.currentTreadDepth;
                          const rateA = wearA > 0 ? a.currentHours / wearA : a.currentHours;
                          const rateB = wearB > 0 ? b.currentHours / wearB : b.currentHours;
                          return rateB - rateA;
                        }).slice(0, 5).map((t, idx) => {
                          const wear = t.initialTreadDepth - t.currentTreadDepth;
                          const hpm = wear > 0 ? (t.currentHours / wear) : 0;
                          const projected = hpm * (t.initialTreadDepth - 5); // project to 5mm
                          return (
                            <div key={t.id} className="flex items-center justify-between p-4 bg-bg-deep rounded border border-border-subtle">
                               <div className="flex items-center gap-4">
                                  <span className="text-xl font-mono font-black text-brand-primary opacity-20">#{idx+1}</span>
                                  <div>
                                     <p className="font-mono font-bold text-white uppercase text-sm">{t.dot}</p>
                                     <p className="text-[10px] text-gray-500 font-bold uppercase">{t.brand} • TAG: {equipment.find(e => e.id === t.equipmentId)?.tag}</p>
                                  </div>
                               </div>
                               <div className="text-right">
                                  <p className="text-sm font-mono font-bold text-brand-secondary">{Math.round(projected)}H</p>
                                  <p className="text-[9px] text-gray-500 font-bold uppercase">Vida Total Est.</p>
                               </div>
                            </div>
                          );
                        })}
                      </div>
                   </div>
                </div>
              </motion.div>
            )}
            {view === 'settings' && (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-2xl mx-auto space-y-10"
              >
                <div>
                  <h2 className="text-3xl font-bold tracking-tight mb-1">Configurações</h2>
                  <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">Ajustes do Terminal e Unidade</p>
                </div>

                <div className="bg-bg-section p-8 lg:p-12 rounded-lg border border-border-subtle shadow-xl space-y-8">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Nome da Unidade Operacional</label>
                    <input 
                      type="text" 
                      value={unitNameInput}
                      onChange={(e) => setUnitNameInput(e.target.value)}
                      placeholder="Ex: Mina Itabira - Setor Norte" 
                      className="w-full bg-bg-deep border border-border-subtle rounded px-6 py-3 font-mono text-lg text-white focus:border-brand-primary transition-all outline-none" 
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div>
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Modelo Padrão de Pneu</label>
                      <input 
                        type="text" 
                        value={defaultTireModelInput}
                        onChange={(e) => setDefaultTireModelInput(e.target.value)}
                        placeholder="Ex: 2400R35" 
                        className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-white focus:border-brand-primary transition-all outline-none" 
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Medida Padrão</label>
                      <input 
                        type="text" 
                        value={defaultTireSizeInput}
                        onChange={(e) => setDefaultTireSizeInput(e.target.value)}
                        placeholder={'Ex: 35"'} 
                        className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-white focus:border-brand-primary transition-all outline-none" 
                      />
                    </div>
                  </div>

                  <button 
                    onClick={updateSettings}
                    className="w-full bg-brand-secondary text-white font-black py-5 rounded hover:brightness-110 transition-all text-sm tracking-[0.15em] uppercase shadow-[0_0_20px_rgba(34,197,94,0.15)]"
                  >
                    Salvar Alterações
                  </button>
                </div>

                <div className="bg-bg-section/50 p-8 rounded-lg border border-border-subtle flex items-center justify-between opacity-60">
                   <div>
                     <p className="text-xs font-bold text-white uppercase mb-1">Versão do Sistema</p>
                     <p className="text-[10px] font-mono">v4.2.1-STABLE-PRODUCTION</p>
                   </div>
                   <div className="text-right text-[10px] font-mono">
                     <p>CID: ITAB-01-2024</p>
                     <p>DB: FIRESTORE-ENTERPRISE</p>
                   </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Mobile Menu Overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 lg:hidden"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="absolute right-0 top-0 bottom-0 w-80 bg-bg-surface p-8 overflow-y-auto shadow-2xl border-l border-border-subtle flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-12">
                <div className="bg-brand-primary w-10 h-10 rounded flex items-center justify-center">
                  <span className="text-black font-black text-lg">TK</span>
                </div>
                <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 hover:bg-bg-card rounded transition-all">
                   <X className="w-8 h-8 text-[#e2e8f0]" />
                </button>
              </div>

              <div className="flex-1">
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.3em] mb-6 pl-4">Navegação Principal</p>
                <nav className="space-y-2">
                  <NavItem id="dashboard" label="Painel" icon={LayoutDashboard} />
                  <NavItem id="equipment" label="Frota Ativa" icon={Truck} />
                  <NavItem id="inventory" label="Estoque Pneus" icon={Database} />
                  <NavItem id="inspections" label="Inspeções" icon={ClipboardCheck} />
                  <NavItem id="reports" label="Relatórios" icon={LayoutDashboard} />
                  <NavItem id="settings" label="Ajustes" icon={Settings} />
                </nav>
              </div>

              <div className="mt-12 pt-12 border-t border-border-subtle">
                <div className="flex items-center gap-4 mb-10 pl-4">
                  <div className="w-12 h-12 rounded bg-brand-primary/10 border border-brand-primary/30 flex items-center justify-center font-black text-brand-primary text-lg uppercase shadow-lg">
                    {profile?.name.charAt(0)}
                  </div>
                  <div>
                    <p className="font-bold text-[#e2e8f0] uppercase tracking-tight text-sm">{profile?.name}</p>
                    <p className="text-[10px] font-bold text-brand-primary uppercase tracking-widest">{profile?.role}</p>
                  </div>
                </div>
                <button 
                  onClick={handleLogout}
                  className="w-full flex items-center justify-center gap-3 px-6 py-4 text-red-400 bg-red-900/10 border border-red-500/20 rounded font-bold text-xs uppercase tracking-widest transition-all hover:bg-red-900/20"
                >
                  <LogOut className="w-4 h-4" />
                  Encerrar Sessão
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modal: Replace Tire */}
      <AnimatePresence>
        {isReplacementModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setIsReplacementModalOpen(false)}
              className="absolute inset-0 bg-black/90 backdrop-blur-sm" 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-bg-surface w-full max-w-xl rounded-lg border border-border-subtle shadow-2xl z-10 overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-border-subtle flex justify-between items-center bg-bg-deep/50">
                <div>
                  <h3 className="text-xl font-bold uppercase tracking-tight">Substituir Pneu</h3>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-1">Posição: {replacementPosition} • Ativo: {equipment.find(e => e.id === activeEquipmentId)?.tag}</p>
                </div>
                <button onClick={() => setIsReplacementModalOpen(false)} className="p-2 hover:bg-bg-card rounded transition-all">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="p-8 space-y-6 overflow-y-auto">
                <div className="space-y-4">
                  <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest">Selecionar Pneu do Estoque</label>
                  <select 
                    value={replacementData.tireId}
                    onChange={(e) => setReplacementData({...replacementData, tireId: e.target.value})}
                    className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-4 font-mono text-sm text-white focus:border-brand-primary outline-none"
                  >
                    <option value="">-- Selecione um pneu (DOT) --</option>
                    {tires.filter(t => t.status === 'inventory').map(t => (
                      <option key={t.id} value={t.id}>{t.dot} ({t.brand}) - {t.currentTreadDepth}mm</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[8px] text-gray-500 uppercase font-black tracking-widest block">Sulco Atual (mm)</label>
                    <input 
                      type="number" 
                      value={replacementData.twi}
                      onChange={(e) => setReplacementData({...replacementData, twi: Number(e.target.value)})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-4 font-mono text-xl text-brand-primary"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[8px] text-gray-500 uppercase font-black tracking-widest block">Pressão Aplicação (PSI)</label>
                    <input 
                      type="number" 
                      value={replacementData.pressure}
                      onChange={(e) => setReplacementData({...replacementData, pressure: Number(e.target.value)})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-4 font-mono text-xl text-brand-secondary"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[8px] text-gray-500 uppercase font-black tracking-widest block">Estado do Pneu</label>
                  <div className="flex gap-2">
                    {['new', 'retreaded', 'repaired'].map((type) => (
                      <button 
                        key={type}
                        onClick={() => setReplacementData({...replacementData, type: type as any})}
                        className={cn(
                          "flex-1 py-3 px-4 rounded border text-[10px] font-black uppercase tracking-widest transition-all",
                          replacementData.type === type ? "bg-brand-primary/10 border-brand-primary text-brand-primary" : "border-border-subtle text-gray-500"
                        )}
                      >
                        {type === 'new' ? 'NOVO' : type === 'retreaded' ? 'REFORMADO' : 'REPARADO'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="p-8 border-t border-border-subtle bg-bg-deep/50">
                <button 
                  onClick={handleReplaceTire}
                  disabled={!replacementData.tireId}
                  className="w-full bg-brand-primary text-black font-black py-4 rounded hover:brightness-110 transition-all text-xs tracking-widest uppercase disabled:opacity-50"
                >
                  Confirmar Montagem
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal: Edit Tire */}
      <AnimatePresence>
        {isEditTireModalOpen && selectedTireToEdit && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setIsEditTireModalOpen(false)}
              className="absolute inset-0 bg-black/90 backdrop-blur-sm" 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-bg-surface w-full max-w-2xl rounded-lg border border-border-subtle shadow-2xl z-10 overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-border-subtle flex justify-between items-center bg-bg-deep/50">
                <div>
                  <h3 className="text-xl font-bold uppercase tracking-tight">Editar Dados do Pneu</h3>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-1">Atualização Manual de Registro</p>
                </div>
                <button onClick={() => setIsEditTireModalOpen(false)} className="p-2 hover:bg-bg-card rounded transition-all">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">DOT / Serial</label>
                    <input 
                      type="text" 
                      value={selectedTireToEdit.dot || ''}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, dot: e.target.value})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Nome do Lote</label>
                    <input 
                      type="text" 
                      value={selectedTireToEdit.batchName || ''}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, batchName: e.target.value})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white" 
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Marca</label>
                    <input 
                      type="text" 
                      value={selectedTireToEdit.brand || ''}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, brand: e.target.value})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Status</label>
                    <select 
                      value={selectedTireToEdit.status || 'inventory'}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, status: e.target.value as any})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white"
                    >
                      <option value="inventory">ESTOQUE</option>
                      <option value="in_use">EM OPERAÇÃO</option>
                      <option value="to_be_retreaded">PARA REFORMA</option>
                      <option value="retreading">EM REFORMA</option>
                      <option value="scrapped">SUCATA</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Sulco Atual (mm)</label>
                    <input 
                      type="number" 
                      value={selectedTireToEdit.currentTreadDepth || 0}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, currentTreadDepth: Number(e.target.value)})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Tipo</label>
                    <select 
                      value={selectedTireToEdit.type || 'new'}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, type: e.target.value as any})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white"
                    >
                      <option value="new">NOVO</option>
                      <option value="retreaded">REFORMADO</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Pressão (PSI)</label>
                    <input 
                      type="number" 
                      value={selectedTireToEdit.pressure || 0}
                      onChange={(e) => setSelectedTireToEdit({...selectedTireToEdit, pressure: Number(e.target.value)})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white" 
                    />
                  </div>
                </div>
              </div>
              <div className="p-8 border-t border-border-subtle bg-bg-deep/50 flex gap-4">
                <button 
                  onClick={async () => {
                    if (!selectedTireToEdit) return;
                    try {
                      await updateDoc(doc(db, 'tires', selectedTireToEdit.id), {
                        ...selectedTireToEdit,
                        updatedAt: new Date().toISOString()
                      });
                      setIsEditTireModalOpen(false);
                      alert("Pneu atualizado com sucesso!");
                    } catch (e) {
                      console.error(e);
                      alert("Erro ao atualizar pneu.");
                    }
                  }}
                  className="flex-1 bg-brand-primary text-black font-black py-4 rounded hover:brightness-110 transition-all text-xs tracking-widest uppercase shadow-lg"
                >
                  Salvar Alterações
                </button>
                <button 
                  onClick={() => setIsEditTireModalOpen(false)}
                  className="px-8 border border-border-subtle text-gray-500 font-bold py-4 rounded hover:bg-bg-card transition-all text-xs uppercase"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal: Register Tire Batch */}
      <AnimatePresence>
        {isRegisterTireModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setIsRegisterTireModalOpen(false)}
              className="absolute inset-0 bg-black/90 backdrop-blur-sm" 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-bg-surface w-full max-w-4xl rounded-lg border border-border-subtle shadow-2xl z-10 overflow-hidden flex flex-col h-[85vh]"
            >
              <div className="p-8 border-b border-border-subtle flex justify-between items-center bg-bg-deep/50">
                <div>
                  <h3 className="text-xl font-bold uppercase tracking-tight">Registro de Lote Unitário</h3>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mt-1">Controle Individual por DOT & TWI</p>
                </div>
                <button onClick={() => setIsRegisterTireModalOpen(false)} className="p-2 hover:bg-bg-card rounded transition-all">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="p-8 space-y-8 overflow-y-auto flex-1">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Identificador do Lote</label>
                    <input 
                      type="text" 
                      value={newBatch.batchName || ''}
                      onChange={(e) => setNewBatch({...newBatch, batchName: e.target.value})}
                      placeholder="Ex: LOTE-AB-2024"
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Data Chegada</label>
                    <input 
                      type="date" 
                      value={newBatch.arrivalDate || ''}
                      onChange={(e) => setNewBatch({...newBatch, arrivalDate: e.target.value})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Marca Padrão</label>
                    <input 
                      type="text" 
                      value={newBatch.brand || ''}
                      onChange={(e) => setNewBatch({...newBatch, brand: e.target.value})}
                      placeholder="Michelin / Goodyear"
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Estado</label>
                    <select 
                      value={newBatch.type || 'new'}
                      onChange={(e) => setNewBatch({...newBatch, type: e.target.value as any})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none"
                    >
                      <option value="new">NOVO</option>
                      <option value="retreaded">REFORMADO</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Status Inicial do Lote</label>
                    <select 
                      value={newBatch.status || 'inventory'}
                      onChange={(e) => setNewBatch({...newBatch, status: e.target.value as any})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none"
                    >
                      <option value="inventory">ESTOQUE</option>
                      <option value="to_be_retreaded">P/ REFORMA</option>
                      <option value="retreading">EM REFORMA</option>
                      <option value="scrapped">SUCATA</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[10px] font-black uppercase text-brand-primary tracking-widest">Pneus no Lote ({newBatch.tires.length})</h4>
                    <button 
                      onClick={() => setNewBatch({
                        ...newBatch, 
                        tires: [...newBatch.tires, { dot: '', treadDepth: 45, brand: newBatch.brand }]
                      })}
                      className="bg-brand-primary/10 text-brand-primary px-4 py-2 rounded text-[10px] font-bold uppercase border border-brand-primary/30 hover:bg-brand-primary/20"
                    >
                      + Adicionar Pneu
                    </button>
                  </div>
                  
                  <div className="space-y-3">
                    {newBatch.tires.map((t, idx) => (
                      <div key={idx} className="grid grid-cols-12 gap-3 bg-bg-deep p-4 rounded border border-border-subtle items-end group">
                        <div className="col-span-5">
                          <label className="block text-[9px] font-bold text-gray-600 uppercase mb-1">DOT / Serial</label>
                          <input 
                            type="text" 
                            value={t.dot}
                            onChange={(e) => {
                              const tires = [...newBatch.tires];
                              tires[idx].dot = e.target.value;
                              setNewBatch({...newBatch, tires});
                            }}
                            placeholder="DOT-XXXX-2024"
                            className="w-full bg-bg-surface border border-border-subtle rounded px-3 py-2 text-xs font-mono text-white"
                          />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[9px] font-bold text-gray-600 uppercase mb-1">TWI (mm)</label>
                          <input 
                            type="number" 
                            value={t.treadDepth}
                            onChange={(e) => {
                              const tires = [...newBatch.tires];
                              tires[idx].treadDepth = parseFloat(e.target.value);
                              setNewBatch({...newBatch, tires});
                            }}
                            className="w-full bg-bg-surface border border-border-subtle rounded px-3 py-2 text-xs font-mono text-white"
                          />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[9px] font-bold text-gray-600 uppercase mb-1">Marca Espec.</label>
                          <input 
                            type="text" 
                            value={t.brand}
                            onChange={(e) => {
                              const tires = [...newBatch.tires];
                              tires[idx].brand = e.target.value;
                              setNewBatch({...newBatch, tires});
                            }}
                            className="w-full bg-bg-surface border border-border-subtle rounded px-3 py-2 text-xs font-mono text-white"
                          />
                        </div>
                        <div className="col-span-1">
                          <button 
                            onClick={() => setNewBatch({...newBatch, tires: newBatch.tires.filter((_, i) => i !== idx)})}
                            className="w-full h-9 flex items-center justify-center text-red-500 hover:bg-red-500/10 rounded transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {newBatch.tires.length === 0 && (
                      <div className="py-12 border border-dashed border-border-subtle rounded flex flex-col items-center justify-center text-gray-600">
                        <Plus className="w-8 h-8 mb-2 opacity-20" />
                        <p className="text-[10px] font-bold uppercase tracking-widest">Nenhum pneu adicionado ao lote</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="p-8 border-t border-border-subtle bg-bg-deep/50 shrink-0">
                <button 
                  onClick={handleRegisterBatch}
                  className="w-full bg-brand-secondary text-white font-black py-4 rounded hover:brightness-110 transition-all text-xs tracking-widest uppercase shadow-lg disabled:opacity-50"
                  disabled={!newBatch.brand || newBatch.tires.length === 0}
                >
                  Finalizar Cadastro do Lote
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal: Register Equipment via Assistant */}
      <AnimatePresence>
        {isRegisterEquipmentModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setIsRegisterEquipmentModalOpen(false)}
              className="absolute inset-0 bg-black/90 backdrop-blur-sm" 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-bg-surface w-full max-w-4xl rounded-lg border border-border-subtle shadow-2xl z-10 overflow-hidden flex flex-col h-[90vh]"
            >
              <div className="p-8 border-b border-border-subtle flex justify-between items-center bg-bg-deep/50 shrink-0">
                <div>
                  <h3 className="text-xl font-bold uppercase tracking-tight">Implantar Novo Equipamento</h3>
                  <p className="text-gray-500 text-sm font-mono uppercase tracking-widest mt-1">Configuração Assistida de Ativos</p>
                </div>
                <button onClick={() => setIsRegisterEquipmentModalOpen(false)} className="p-2 hover:bg-bg-card rounded transition-all">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-8 space-y-12">
                {/* Header Info */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">TAG / Identificação</label>
                    <input 
                      type="text" 
                      value={newEquipment.tag || ''}
                      onChange={(e) => setNewEquipment({...newEquipment, tag: e.target.value})}
                      placeholder="Ex: CAT-001"
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Horímetro Atual</label>
                    <input 
                      type="number" 
                      value={newEquipment.hourMeter || 0}
                      onChange={(e) => setNewEquipment({...newEquipment, hourMeter: parseInt(e.target.value)})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Data da Implantação</label>
                    <input 
                      type="date" 
                      value={newEquipment.registrationDate || ''}
                      onChange={(e) => setNewEquipment({...newEquipment, registrationDate: e.target.value})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Status do Ativo</label>
                    <select 
                      value={newEquipment.status || 'in_operation'}
                      onChange={(e) => setNewEquipment({...newEquipment, status: e.target.value as EquipmentStatus})}
                      className="w-full bg-bg-deep border border-border-subtle rounded px-4 py-3 font-mono text-sm text-white focus:border-brand-primary outline-none appearance-none"
                    >
                      <option value="in_operation">Em Operação</option>
                      <option value="active">Ativo / Disponível</option>
                      <option value="in_maintenance">Em Manutenção</option>
                      <option value="idle">Ocioso</option>
                    </select>
                  </div>
                </div>

                <div className="h-px bg-border-subtle" />

                   <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                     {/* Diagrama Visual (Baseado na Imagem de Referência) */}
                     <div className="bg-bg-deep p-10 rounded-lg border border-border-subtle relative overflow-hidden flex items-center justify-center min-h-[600px]">
                        <div className="absolute inset-0 opacity-5 pointer-events-none flex flex-col justify-between p-10">
                           <div className="w-full h-px bg-white" />
                           <div className="w-full h-px bg-white" />
                           <div className="w-full h-px bg-white" />
                        </div>

                        {/* Chassi Central */}
                        <div className="absolute w-12 h-[80%] bg-border-subtle opacity-20 rounded-sm" />
                        
                        {/* Eixos e Pneus */}
                        <div className="relative w-full h-full flex flex-col items-center gap-16 z-10">
                          
                          {/* Eixo 1 (Direcional) */}
                          <div className="relative w-full flex justify-between items-center max-w-[300px]">
                             <div className="absolute w-full h-1 bg-border-subtle/50 top-1/2 -translate-y-1/2" />
                             {[1, 2].map(pos => {
                               const p = pos.toString();
                               const isActive = newEquipment.selectedPosition === p;
                               const isConfigured = newEquipment.tires[pos-1].dot !== '';
                               return (
                                 <TireAnchor 
                                   key={p} 
                                   pos={p} 
                                   isActive={isActive} 
                                   isConfigured={isConfigured} 
                                   onClick={() => setNewEquipment({...newEquipment, selectedPosition: p})} 
                                 />
                               );
                             })}
                          </div>

                          {/* Eixo 2 (Direcional) */}
                          <div className="relative w-full flex justify-between items-center max-w-[300px]">
                             <div className="absolute w-full h-1 bg-border-subtle/50 top-1/2 -translate-y-1/2" />
                             {[3, 4].map(pos => {
                               const p = pos.toString();
                               const isActive = newEquipment.selectedPosition === p;
                               const isConfigured = newEquipment.tires[pos-1].dot !== '';
                               return (
                                 <TireAnchor 
                                   key={p} 
                                   pos={p} 
                                   isActive={isActive} 
                                   isConfigured={isConfigured} 
                                   onClick={() => setNewEquipment({...newEquipment, selectedPosition: p})} 
                                 />
                               );
                             })}
                          </div>

                          {/* Eixo 3 (Tração - Duplo) */}
                          <div className="relative w-full flex justify-between items-center max-w-[450px]">
                             <div className="absolute w-full h-1 bg-border-subtle/50 top-1/2 -translate-y-1/2" />
                             <div className="flex gap-2">
                               {[5, 6].map(pos => (
                                 <TireAnchor 
                                   key={pos} 
                                   pos={pos.toString()} 
                                   isActive={newEquipment.selectedPosition === pos.toString()} 
                                   isConfigured={newEquipment.tires[pos-1].dot !== ''}
                                   onClick={() => setNewEquipment({...newEquipment, selectedPosition: pos.toString()})} 
                                 />
                               ))}
                             </div>
                             <div className="flex gap-2">
                               {[7, 8].map(pos => (
                                 <TireAnchor 
                                   key={pos} 
                                   pos={pos.toString()} 
                                   isActive={newEquipment.selectedPosition === pos.toString()} 
                                   isConfigured={newEquipment.tires[pos-1].dot !== ''}
                                   onClick={() => setNewEquipment({...newEquipment, selectedPosition: pos.toString()})} 
                                 />
                               ))}
                             </div>
                          </div>

                          {/* Eixo 4 (Tração - Duplo) */}
                          <div className="relative w-full flex justify-between items-center max-w-[450px]">
                             <div className="absolute w-full h-1 bg-border-subtle/50 top-1/2 -translate-y-1/2" />
                             <div className="flex gap-2">
                               {[9, 10].map(pos => (
                                 <TireAnchor 
                                   key={pos} 
                                   pos={pos.toString()} 
                                   isActive={newEquipment.selectedPosition === pos.toString()} 
                                   isConfigured={newEquipment.tires[pos-1].dot !== ''}
                                   onClick={() => setNewEquipment({...newEquipment, selectedPosition: pos.toString()})} 
                                 />
                               ))}
                             </div>
                             <div className="flex gap-2">
                               {[11, 12].map(pos => (
                                 <TireAnchor 
                                   key={pos} 
                                   pos={pos.toString()} 
                                   isActive={newEquipment.selectedPosition === pos.toString()} 
                                   isConfigured={newEquipment.tires[pos-1].dot !== ''}
                                   onClick={() => setNewEquipment({...newEquipment, selectedPosition: pos.toString()})} 
                                 />
                               ))}
                             </div>
                          </div>

                        </div>
                        
                        <div className="absolute bottom-6 right-6 flex items-center gap-6">
                           <div className="flex items-center gap-2">
                              <div className="w-3 h-4 bg-brand-primary/20 border border-brand-primary rounded" />
                              <span className="text-[8px] font-bold text-gray-500 uppercase">Selecionado</span>
                           </div>
                           <div className="flex items-center gap-2">
                              <div className="w-3 h-4 bg-emerald-500/20 border border-emerald-500 rounded" />
                              <span className="text-[8px] font-bold text-gray-500 uppercase">Mapeado</span>
                           </div>
                        </div>
                     </div>

                     {/* Detalhes da Posição Selecionada */}
                     <div className="space-y-6">
                        {(() => {
                          const idx = parseInt(newEquipment.selectedPosition) - 1;
                          const t = newEquipment.tires[idx];
                          return (
                            <div className="bg-bg-deep p-8 rounded-lg border border-brand-primary/20 space-y-6 relative overflow-hidden">
                               <div className="absolute top-0 right-0 p-4 opacity-5">
                                 <Plus className="w-24 h-24" />
                               </div>
                               <h4 className="text-xl font-bold uppercase tracking-tight flex items-center gap-3">
                                 <span className="bg-brand-primary text-black px-3 py-1 rounded text-sm">P{newEquipment.selectedPosition}</span>
                                 Configuração do Pneu
                               </h4>
                               
                               <div className="space-y-4">
                                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Vincular por Lote (Data)</label>
                                     <select 
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-xs text-white outline-none"
                                       onChange={(e) => {
                                         const selectedTire = tires.find(tire => tire.id === e.target.value);
                                         if (selectedTire) {
                                           const tiresList = [...newEquipment.tires];
                                           tiresList[idx] = {
                                             ...tiresList[idx],
                                             dot: selectedTire.dot,
                                             batchName: selectedTire.batchName || '',
                                             brand: selectedTire.brand,
                                             type: selectedTire.type as any,
                                             treadDepth: selectedTire.currentTreadDepth
                                           };
                                           setNewEquipment({...newEquipment, tires: tiresList});
                                         }
                                       }}
                                     >
                                       <option value="">Selecione pelo Lote...</option>
                                       {(() => {
                                          const availableTires = tires.filter(t => t.status === 'inventory' || t.id === newEquipment.tires[idx].dot);
                                          const groups = availableTires.reduce((acc, t) => {
                                            const key = t.arrivalDate || 'Sem Data';
                                            if (!acc[key]) acc[key] = [];
                                            acc[key].push(t);
                                            return acc;
                                          }, {} as Record<string, Tire[]>);

                                          return (Object.entries(groups).sort((a: [string, Tire[]], b: [string, Tire[]]) => b[0].localeCompare(a[0])) as [string, Tire[]][]).map((entry) => {
                                            const date = entry[0];
                                            const tl = entry[1];
                                            return (
                                              <optgroup key={date} label={`Lote: ${date}`}>
                                                {tl.map((tire: Tire) => (
                                                  <option key={tire.id} value={tire.id}>
                                                    {tire.batchName || tire.dot} | {tire.brand} ({tire.currentTreadDepth}mm)
                                                  </option>
                                                ))}
                                              </optgroup>
                                            );
                                          });
                                       })()}
                                     </select>
                                   </div>
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Ou digite o DOT manualmente</label>
                                     <input 
                                       type="text" 
                                       placeholder="Digite DOT"
                                       value={t.dot || ''}
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].dot = e.target.value;
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-xs text-brand-primary focus:border-brand-primary outline-none" 
                                     />
                                   </div>
                                 </div>
 
                                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Nome do Lote</label>
                                     <input 
                                       type="text" 
                                       placeholder="Ex: LOTE-MINA-01"
                                       value={t.batchName || ''}
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].batchName = e.target.value;
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-xs text-white" 
                                     />
                                   </div>
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Status do Pneu</label>
                                     <select 
                                       value={t.status || 'in_use'}
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].status = e.target.value as any;
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className={cn(
                                         "w-full bg-bg-surface border rounded px-4 py-3 font-mono text-xs",
                                         t.status === 'in_use' ? "border-brand-secondary text-brand-secondary" :
                                         t.status === 'to_be_retreaded' ? "border-amber-500 text-amber-500" :
                                         t.status === 'scrapped' ? "border-red-500 text-red-500" : "border-border-subtle"
                                       )}
                                     >
                                       <option value="in_use">EM OPERAÇÃO</option>
                                       <option value="to_be_retreaded">ENVIAR P/ REFORMA</option>
                                       <option value="scrapped">SUCATEAR</option>
                                       <option value="inventory">ESTOQUE</option>
                                     </select>
                                   </div>
                                 </div>
 
                                 <div className="grid grid-cols-2 gap-4">
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">TWI Atual (mm)</label>
                                     <input 
                                       type="number" 
                                       value={t.treadDepth || 0}
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].treadDepth = parseFloat(e.target.value);
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-sm" 
                                     />
                                   </div>
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Pressão (PSI)</label>
                                     <input 
                                       type="number" 
                                       value={t.pressure || 0}
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].pressure = parseFloat(e.target.value);
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-sm" 
                                     />
                                   </div>
                                 </div>

                                 <div className="grid grid-cols-2 gap-4">
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Marca</label>
                                     <input 
                                       type="text" 
                                       value={t.brand || ''}
                                       placeholder="Michelin"
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].brand = e.target.value;
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-sm" 
                                     />
                                   </div>
                                   <div>
                                     <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Tipo</label>
                                     <select 
                                       value={t.type || 'new'}
                                       onChange={(e) => {
                                         const tires = [...newEquipment.tires];
                                         tires[idx].type = e.target.value as any;
                                         setNewEquipment({...newEquipment, tires});
                                       }}
                                       className="w-full bg-bg-surface border border-border-subtle rounded px-4 py-3 font-mono text-sm"
                                     >
                                       <option value="new">NOVO</option>
                                       <option value="retreaded">REFORMADO</option>
                                     </select>
                                   </div>
                                 </div>
                               </div>
                            </div>
                          );
                        })()}
                     </div>
                </div>
              </div>

              <div className="p-8 border-t border-border-subtle shrink-0">
                 <button 
                  onClick={handleRegisterEquipment}
                  className="w-full bg-brand-secondary text-white font-black py-4 rounded hover:brightness-110 transition-all text-xs tracking-widest uppercase shadow-lg disabled:opacity-50"
                  disabled={!newEquipment.tag}
                 >
                   Salvar Ativo e Atualizar Frota
                 </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
