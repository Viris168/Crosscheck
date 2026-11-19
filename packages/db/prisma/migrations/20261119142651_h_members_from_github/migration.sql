-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "needsMemberPermission" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "githubAccountType" TEXT;
