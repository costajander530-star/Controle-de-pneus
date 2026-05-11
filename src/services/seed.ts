import { db } from './firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export async function seedInitialData() {
  const tiresRef = collection(db, 'tires');
  const equipmentRef = collection(db, 'equipment');

  // Seed Equipment
  const trucks = [
    { tag: 'CAM-101', model: 'Cat 797F', hourMeter: 12500, loadCapacity: 400, operationType: 'Ore Transport', site: 'Cava Norte' },
    { tag: 'CAM-102', model: 'Komatsu 930E', hourMeter: 8400, loadCapacity: 320, operationType: 'Waste Transport', site: 'Cava Sul' },
  ];

  for (const truck of trucks) {
    await addDoc(equipmentRef, truck);
  }

  // Seed Tires
  const tires = [
    { dot: 'MI-2024-X9', brand: 'Michelin', model: 'XDR3', size: '59/80R63', type: 'new', acquisitionCost: 45000, initialTreadDepth: 110, expectedHours: 6000, expectedWearMm: 100, status: 'in_use', currentHours: 1200, currentTreadDepth: 95, createdAt: serverTimestamp() },
    { dot: 'BR-2023-P2', brand: 'Bridgestone', model: 'VRPS', size: '59/80R63', type: 'new', acquisitionCost: 42000, initialTreadDepth: 105, expectedHours: 5500, expectedWearMm: 95, status: 'inventory', currentHours: 0, currentTreadDepth: 105, createdAt: serverTimestamp() },
    { dot: 'GY-2024-M1', brand: 'Goodyear', model: 'RM-4B+', size: '59/80R63', type: 'new', acquisitionCost: 43000, initialTreadDepth: 108, expectedHours: 5800, expectedWearMm: 98, status: 'in_use', currentHours: 4500, currentTreadDepth: 8, createdAt: serverTimestamp() },
  ];

  for (const tire of tires) {
    await addDoc(tiresRef, tire);
  }
}
