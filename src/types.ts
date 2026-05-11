export type UserRole = 'inspector' | 'mechanic' | 'planner' | 'admin';

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  site?: string;
  unitName?: string;
}

export type TireStatus = 'inventory' | 'in_use' | 'retreading' | 'scrapped' | 'to_be_retreaded';

export interface Tire {
  id: string;
  dot: string;
  batchName?: string;
  brand: string;
  model: string;
  size: string;
  type: 'new' | 'retreaded' | 'repaired';
  acquisitionCost: number;
  initialTreadDepth: number;
  expectedHours: number;
  expectedWearMm: number;
  status: TireStatus;
  currentHours: number;
  currentTreadDepth: number;
  equipmentId?: string;
  position?: string;
  arrivalDate?: string;
  pressure?: number;
  createdAt: any;
  updatedAt?: any;
}

export type EquipmentStatus = 'active' | 'in_maintenance' | 'in_operation' | 'idle';

export interface Equipment {
  id: string;
  tag: string;
  model: string;
  hourMeter: number;
  loadCapacity: number;
  operationType: string;
  site: string;
  status?: EquipmentStatus;
  registrationDate?: string;
}

export interface TireBatch {
  id: string;
  arrivalDate: string;
  brand: string;
  type: 'new' | 'retreaded';
  initialTreadDepth: number;
  quantity: number;
  dotPrefix?: string;
}

export interface Inspection {
  id: string;
  tireId: string;
  equipmentId?: string;
  inspectorId: string;
  date: any;
  treadDepthPoints: number[];
  temperature: number;
  pressure: number;
  equipmentHourMeter?: number;
  condition: string;
  photoUrl?: string;
}

export interface WorkOrder {
  id: string;
  type: 'mount' | 'unmount' | 'rotate' | 'inspect' | 'retread';
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  tireId?: string;
  equipmentId?: string;
  description: string;
  cost?: number;
  technicianId?: string;
  createdAt: any;
  completedAt?: any;
}
