-- CreateTable
CREATE TABLE "BrokerAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrokerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StrategyBroker" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "strategyId" INTEGER NOT NULL,
    "brokerAccountId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StrategyBroker_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StrategyBroker_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "BrokerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
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
    CONSTRAINT "Order_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "BrokerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "lastStrategyId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_lastStrategyId_fkey" FOREIGN KEY ("lastStrategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("createdAt", "email", "id", "name", "password", "updatedAt") SELECT "createdAt", "email", "id", "name", "password", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_lastStrategyId_key" ON "User"("lastStrategyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "StrategyBroker_strategyId_brokerAccountId_key" ON "StrategyBroker"("strategyId", "brokerAccountId");
