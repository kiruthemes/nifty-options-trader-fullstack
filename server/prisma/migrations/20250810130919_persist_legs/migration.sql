/*
  Warnings:

  - You are about to drop the column `entryAt` on the `Leg` table. All the data in the column will be lost.
  - You are about to drop the column `exitAt` on the `Leg` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `Leg` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Leg" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "strategyId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STAGED',
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "strike" INTEGER NOT NULL,
    "premium" REAL NOT NULL DEFAULT 0,
    "lots" INTEGER NOT NULL DEFAULT 1,
    "expiry" TEXT NOT NULL,
    "entryPrice" REAL,
    "exitPrice" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Leg_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Leg" ("entryPrice", "exitPrice", "expiry", "id", "lots", "side", "status", "strategyId", "strike", "type") SELECT "entryPrice", "exitPrice", "expiry", "id", "lots", "side", "status", "strategyId", "strike", "type" FROM "Leg";
DROP TABLE "Leg";
ALTER TABLE "new_Leg" RENAME TO "Leg";
CREATE TABLE "new_Strategy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "defaultLots" INTEGER NOT NULL DEFAULT 1,
    "underlying" TEXT NOT NULL DEFAULT 'NIFTY',
    "atmBasis" TEXT NOT NULL DEFAULT 'spot',
    "selectedExpiry" TEXT,
    "realized" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Strategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Strategy" ("createdAt", "defaultLots", "id", "isArchived", "name", "updatedAt", "userId") SELECT "createdAt", "defaultLots", "id", "isArchived", "name", "updatedAt", "userId" FROM "Strategy";
DROP TABLE "Strategy";
ALTER TABLE "new_Strategy" RENAME TO "Strategy";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
