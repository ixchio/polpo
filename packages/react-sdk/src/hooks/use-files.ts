import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type { FileRoot, FileEntry, FilePreview } from "@polpo-ai/sdk";

export interface UseFilesReturn {
  roots: FileRoot[];
  entries: FileEntry[];
  currentPath: string | null;
  isLoading: boolean;
  error: Error | null;
  listFiles: (path?: string) => Promise<FileEntry[]>;
  isListing: boolean;
  previewFile: (path: string, maxLines?: number) => Promise<FilePreview>;
  isPreviewing: boolean;
  readFile: (path: string, download?: boolean) => Promise<Response>;
  uploadFile: (destPath: string, file: File | Blob, filename: string) => Promise<{ uploaded: { name: string; size: number }[]; count: number }>;
  isUploading: boolean;
  createDirectory: (path: string) => Promise<{ path: string }>;
  isCreatingDir: boolean;
  renameFile: (path: string, newName: string) => Promise<{ oldPath: string; newName: string }>;
  isRenaming: boolean;
  deleteFile: (path: string) => Promise<boolean>;
  isDeleting: boolean;
  searchFiles: (query?: string, root?: string, limit?: number) => Promise<{ files: { name: string; path: string }[]; total: number }>;
  isSearching: boolean;
  refetchRoots: () => Promise<void>;
}

export function useFiles(path?: string): UseFilesReturn {
  const { client } = usePolpoContext();

  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetchRoots = useCallback(async () => {
    try {
      const data = await client.getFileRoots();
      setRoots(data.roots);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  // Fetch roots on mount
  useEffect(() => {
    setIsLoading(true);
    refetchRoots().finally(() => setIsLoading(false));
  }, [refetchRoots]);

  // Auto-fetch entries when path changes
  useEffect(() => {
    if (!path) {
      setEntries([]);
      setCurrentPath(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    client
      .listFiles(path)
      .then((data) => {
        if (!cancelled) {
          setEntries(data.entries);
          setCurrentPath(data.path);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
          setIsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [client, path]);

  const { mutate: listFiles, isPending: isListing } = useMutation(
    useCallback(
      async (listPath?: string) => {
        const data = await client.listFiles(listPath);
        setEntries(data.entries);
        setCurrentPath(data.path);
        return data.entries;
      },
      [client],
    ),
  );

  const { mutate: previewFile, isPending: isPreviewing } = useMutation(
    useCallback(
      async (previewPath: string, maxLines?: number) => {
        return client.previewFile(previewPath, maxLines);
      },
      [client],
    ),
  );

  const readFile = useCallback(
    (path: string, download?: boolean) => client.readFile(path, download),
    [client],
  );

  const { mutate: uploadFile, isPending: isUploading } = useMutation(
    useCallback(
      async (destPath: string, file: File | Blob, filename: string) => {
        const result = await client.uploadFile(destPath, file, filename);
        // Refresh entries if uploading to current path
        if (currentPath) {
          const data = await client.listFiles(currentPath);
          setEntries(data.entries);
        }
        return result;
      },
      [client, currentPath],
    ),
  );

  const { mutate: createDirectory, isPending: isCreatingDir } = useMutation(
    useCallback(
      async (dirPath: string) => {
        const result = await client.createDirectory(dirPath);
        if (currentPath) {
          const data = await client.listFiles(currentPath);
          setEntries(data.entries);
        }
        return result;
      },
      [client, currentPath],
    ),
  );

  const { mutate: renameFile, isPending: isRenaming } = useMutation(
    useCallback(
      async (renamePath: string, newName: string) => {
        const result = await client.renameFile(renamePath, newName);
        setEntries((prev) =>
          prev.map((e) => e.name === renamePath.split("/").pop() ? { ...e, name: newName } : e),
        );
        return result;
      },
      [client],
    ),
  );

  const { mutate: deleteFile, isPending: isDeleting } = useMutation(
    useCallback(
      async (deletePath: string) => {
        await client.deleteFile(deletePath);
        setEntries((prev) => prev.filter((e) => e.name !== deletePath.split("/").pop()));
        return true;
      },
      [client],
    ),
  );

  const { mutate: searchFiles, isPending: isSearching } = useMutation(
    useCallback(
      async (query?: string, root?: string, limit?: number) => {
        return client.searchFiles(query, root, limit);
      },
      [client],
    ),
  );

  return {
    roots,
    entries,
    currentPath,
    isLoading,
    error,
    listFiles,
    isListing,
    previewFile,
    isPreviewing,
    readFile,
    uploadFile,
    isUploading,
    createDirectory,
    isCreatingDir,
    renameFile,
    isRenaming,
    deleteFile,
    isDeleting,
    searchFiles,
    isSearching,
    refetchRoots,
  };
}
