import { call as sendEmail } from "../../vendor/email/index";
import { logOutreach } from "./outreach-log";
export function send(to: string, body: string) { sendEmail(body); logOutreach(to); }
