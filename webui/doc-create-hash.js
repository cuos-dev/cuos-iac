#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import bcrypt from 'bcrypt';

// alternative:
// htpasswd -nbB USERNAME yourPasswordHere
if (!process.argv[2]) {
	console.warn("Usage: prog password");
	process.exit(2);
}

bcrypt.hash(process.argv[2], 10, (err, hash) => console.log(hash))
