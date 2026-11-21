-- CreateEnum
CREATE TYPE "TreeSyncStatus" AS ENUM ('idle', 'syncing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "CiState" AS ENUM ('success', 'failure', 'pending', 'neutral', 'none');

-- CreateEnum
CREATE TYPE "MergedVia" AS ENUM ('pr', 'rebased', 'squashed');

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "baseSha" TEXT,
ADD COLUMN     "mergeCommitSha" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RepoGraph" (
    "repoId" TEXT NOT NULL,
    "status" "TreeSyncStatus" NOT NULL DEFAULT 'idle',
    "errorCode" "ErrorCode",
    "defaultBranch" TEXT,
    "syncedAt" TIMESTAMP(3),
    "snapshot" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoGraph_pkey" PRIMARY KEY ("repoId")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "recordedParents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recordedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitCi" (
    "repoId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "state" "CiState" NOT NULL,
    "counts" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitCi_pkey" PRIMARY KEY ("repoId","sha")
);

-- CreateTable
CREATE TABLE "CompareOverride" (
    "repoId" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "compareWith" TEXT NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompareOverride_pkey" PRIMARY KEY ("repoId","branchName")
);

-- CreateTable
CREATE TABLE "GitEvent" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "before" TEXT,
    "after" TEXT,
    "prNumber" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Branch_repoId_deletedAt_idx" ON "Branch"("repoId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_repoId_name_key" ON "Branch"("repoId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GitEvent_deliveryId_key" ON "GitEvent"("deliveryId");

-- CreateIndex
CREATE INDEX "GitEvent_repoId_receivedAt_idx" ON "GitEvent"("repoId", "receivedAt");

-- AddForeignKey
ALTER TABLE "RepoGraph" ADD CONSTRAINT "RepoGraph_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
