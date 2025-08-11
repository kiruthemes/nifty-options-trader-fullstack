-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BrokerAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT,
    "clientId" TEXT,
    "apiKey" TEXT,
    "apiSecret" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrokerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BrokerAccount" ("accessToken", "apiKey", "apiSecret", "clientId", "createdAt", "id", "label", "provider", "refreshToken", "updatedAt", "userId") SELECT "accessToken", "apiKey", "apiSecret", "clientId", "createdAt", "id", "label", "provider", "refreshToken", "updatedAt", "userId" FROM "BrokerAccount";
DROP TABLE "BrokerAccount";
ALTER TABLE "new_BrokerAccount" RENAME TO "BrokerAccount";
CREATE INDEX "BrokerAccount_userId_idx" ON "BrokerAccount"("userId");
CREATE INDEX "BrokerAccount_provider_idx" ON "BrokerAccount"("provider");
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
    CONSTRAINT "Leg_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Leg" ("createdAt", "entryPrice", "exitPrice", "expiry", "id", "lots", "premium", "side", "status", "strategyId", "strike", "type", "updatedAt") SELECT "createdAt", "entryPrice", "exitPrice", "expiry", "id", "lots", "premium", "side", "status", "strategyId", "strike", "type", "updatedAt" FROM "Leg";
DROP TABLE "Leg";
ALTER TABLE "new_Leg" RENAME TO "Leg";
CREATE INDEX "Leg_strategyId_idx" ON "Leg"("strategyId");
CREATE TABLE "new_Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "strategyId" INTEGER NOT NULL,
    "legId" INTEGER,
    "brokerAccountId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestJson" TEXT NOT NULL DEFAULT '{}',
    "responseJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Order_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "BrokerAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("brokerAccountId", "createdAt", "id", "legId", "provider", "providerOrderId", "requestJson", "responseJson", "status", "strategyId", "updatedAt") SELECT "brokerAccountId", "createdAt", "id", "legId", "provider", "providerOrderId", "requestJson", "responseJson", "status", "strategyId", "updatedAt" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE INDEX "Order_strategyId_idx" ON "Order"("strategyId");
CREATE INDEX "Order_brokerAccountId_idx" ON "Order"("brokerAccountId");
CREATE INDEX "Order_provider_idx" ON "Order"("provider");
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
    CONSTRAINT "Strategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Strategy" ("atmBasis", "createdAt", "defaultLots", "id", "isArchived", "name", "realized", "selectedExpiry", "underlying", "updatedAt", "userId") SELECT "atmBasis", "createdAt", "defaultLots", "id", "isArchived", "name", "realized", "selectedExpiry", "underlying", "updatedAt", "userId" FROM "Strategy";
DROP TABLE "Strategy";
ALTER TABLE "new_Strategy" RENAME TO "Strategy";
CREATE INDEX "Strategy_userId_idx" ON "Strategy"("userId");
CREATE TABLE "new_StrategyBroker" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "strategyId" INTEGER NOT NULL,
    "brokerAccountId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StrategyBroker_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StrategyBroker_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "BrokerAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_StrategyBroker" ("brokerAccountId", "createdAt", "enabled", "id", "strategyId") SELECT "brokerAccountId", "createdAt", "enabled", "id", "strategyId" FROM "StrategyBroker";
DROP TABLE "StrategyBroker";
ALTER TABLE "new_StrategyBroker" RENAME TO "StrategyBroker";
CREATE INDEX "StrategyBroker_strategyId_idx" ON "StrategyBroker"("strategyId");
CREATE INDEX "StrategyBroker_brokerAccountId_idx" ON "StrategyBroker"("brokerAccountId");
CREATE UNIQUE INDEX "StrategyBroker_strategyId_brokerAccountId_key" ON "StrategyBroker"("strategyId", "brokerAccountId");
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "dataProvider" TEXT NOT NULL DEFAULT 'synthetic',
    "lastStrategyId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_lastStrategyId_fkey" FOREIGN KEY ("lastStrategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("createdAt", "email", "id", "lastStrategyId", "name", "password", "updatedAt") SELECT "createdAt", "email", "id", "lastStrategyId", "name", "password", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_lastStrategyId_key" ON "User"("lastStrategyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
