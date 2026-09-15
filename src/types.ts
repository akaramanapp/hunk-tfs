/** Normalized TFS / Azure DevOps Server connection settings. */
export interface TfsConnection {
  /** Collection root, e.g. http://host:8080/tfs/DefaultCollection */
  readonly url: string;
  readonly pat: string;
  readonly project: string;
  readonly repository: string;
  /** REST api-version query value. */
  readonly apiVersion: string;
}

export interface TfsPullRequestTarget {
  readonly project: string;
  readonly repository: string;
  readonly id: string;
}

export interface TfsCommitRef {
  readonly commitId: string;
}

/** Subset of Azure DevOps GitPullRequest used by this extension. */
export interface TfsPullRequest {
  readonly pullRequestId: number;
  readonly title: string;
  readonly status: string;
  readonly isDraft?: boolean;
  readonly creationDate?: string;
  readonly createdBy?: { readonly displayName?: string; readonly uniqueName?: string };
  readonly sourceRefName?: string;
  readonly targetRefName?: string;
  readonly lastMergeSourceCommit?: TfsCommitRef;
  readonly lastMergeTargetCommit?: TfsCommitRef;
  readonly url?: string;
  /** Present when resolved via collection-scoped get-by-id. */
  readonly project?: string;
  readonly repository?: string;
}

export type TfsChangeType = "add" | "edit" | "delete" | "rename" | "other";

export interface TfsFileChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly changeType: TfsChangeType;
}

export interface TfsThreadPosition {
  readonly filePath: string;
  readonly side: "old" | "new";
  readonly line: number;
  /** Inclusive end line when the thread spans a range; defaults to `line`. */
  readonly endLine?: number;
}

export interface TfsThreadComment {
  readonly id: number;
  readonly author: string;
  readonly content: string;
  readonly publishedDate?: string;
}

/** One non-system PR discussion thread, ready for the Comments pane. */
export interface TfsReviewThread {
  readonly id: number;
  readonly status: string;
  readonly position: TfsThreadPosition | null;
  readonly comments: readonly TfsThreadComment[];
}
