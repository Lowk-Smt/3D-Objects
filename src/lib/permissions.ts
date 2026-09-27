/**
 * Pure workspace permission rules.
 *
 * These are deliberately dependency-free so the unit tests can pin the exact
 * authorization matrix without a database or HTTP layer. src/lib/auth.ts
 * re-exports them; every API route enforces them server-side (the frontend
 * only hides buttons).
 *
 * The matrix (unchanged by the R2 migration):
 *
 *  - Any authenticated member may list, preview (raw), download, upload,
 *    rename and read thumbnails — this is a shared private library, not
 *    per-user isolated storage.
 *  - Deleting requires the owner role or the per-member `canDelete` flag.
 *  - Creating/replacing a file's shared thumbnail requires being the
 *    uploader of that file or the workspace owner.
 *  - Completing a presigned upload requires being the member who started it
 *    (the pending row's uploader) or the workspace owner.
 *  - Member management requires the owner role.
 */

export type Role = "owner" | "member";

export type PermissionUser = {
  id: string;
  role: Role;
  canDelete: boolean;
};

export function isOwner(user: PermissionUser): boolean {
  return user.role === "owner";
}

export function canUserDeleteFiles(user: PermissionUser): boolean {
  return user.role === "owner" || user.canDelete;
}

export function canUserManageThumbnail(
  user: PermissionUser,
  file: { uploaderId: string | null },
): boolean {
  if (user.role === "owner") return true;
  return !!file.uploaderId && file.uploaderId === user.id;
}

export function canUserCompleteUpload(
  user: PermissionUser,
  pending: { uploaderId: string | null },
): boolean {
  if (user.role === "owner") return true;
  return !!pending.uploaderId && pending.uploaderId === user.id;
}
