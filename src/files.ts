export interface FileUploadClient {
  files: {
    uploadV2(args: {
      channel_id: string;
      thread_ts?: string;
      filename: string;
      content?: string;
      title?: string;
      initial_comment?: string;
    }): Promise<unknown>;
  };
}

export interface UploadArgs {
  channel: string;
  threadTs?: string;
  content: string;
  filename: string;
  title?: string;
  initialComment?: string;
}

export async function uploadAsFile(
  client: FileUploadClient,
  args: UploadArgs,
): Promise<void> {
  await client.files.uploadV2({
    channel_id: args.channel,
    ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    filename: args.filename,
    content: args.content,
    ...(args.title ? { title: args.title } : {}),
    ...(args.initialComment ? { initial_comment: args.initialComment } : {}),
  });
}

export function fileNameFor(command: string, nowMs: number = Date.now()): string {
  const sanitized = command.replace(/[^a-z0-9_-]/gi, '_').slice(0, 32) || 'oc';
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${sanitized}-${stamp}.md`;
}
