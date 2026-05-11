# Security Specification: TyreTrack Pro

## Data Invariants
1. A Tire cannot be 'in_use' without an associated Equipment ID and position.
2. An Inspection must link to an existing Tire.
3. Users can only modify data if they have a profile with a valid role (inspector, mechanic, planner, admin).
4. Critical fields like `acquisitionCost` and `dot` are immutable after creation.
5. Work orders can only be marked 'completed' by users with 'mechanic' or 'admin' roles.

## Dirty Dozen Payloads (Red Team Tests)
1. **Unauthorized Tire Creation**: Anonymous user attempting to create a tire.
2. **Identity Spoofing**: User A trying to update User B's profile role to 'admin'.
3. **Invalid DOT**: Creating a tire with a 1MB string as DOT.
4. **Illegal Status Jump**: Changing a tire status from 'scrapped' back to 'new'.
5. **Orphaned Inspection**: Creating an inspection for a non-existent tire ID.
6. **Negative Tread Depth**: Setting initialTreadDepth to -5mm.
7. **Bypassing Mandatory Fields**: Creating Equipment without a Tag.
8. **Field Injection**: Adding `isVerified: true` to a Tire document.
9. **Illegal Position**: Mounting a tire to position 'X11' (only 1-10 allowed).
10. **Timestamp Fraud**: Setting `createdAt` to a date in the future (not request.time).
11. **PII Leakage**: Regular inspector trying to read 'users' collection without explicit filter.
12. **Massive Array**: Injecting 10,000 points into `treadDepthPoints`.

## Rules Logic
- `isValidTire()`: Checks types, sizes, and immutable fields.
- `isAdmin()`, `isPlanner()`, `isInspector()`, `isMechanic()`: Role-based helpers.
- `allow list`: Enforces site-based or role-based filtering.
