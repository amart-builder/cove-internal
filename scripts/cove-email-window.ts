#!/usr/bin/env node
import { currentEmailTriageContext } from "../src/lib/email/catchup";

process.stdout.write(`${JSON.stringify(currentEmailTriageContext())}\n`);
