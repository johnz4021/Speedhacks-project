import { complete } from "../gateway/complete";
export const draftEmail = (company: string) => complete({ purpose: "email", messages: [company] });
