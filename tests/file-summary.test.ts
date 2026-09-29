import { describe, it, expect } from "vitest";
import { extractCode } from "../src/extract/code.js";
import { fileSummary, summarizeDocLines, isDirective } from "../src/extract/doc-text.js";

// File summaries were license boilerplate, preprocessor lines or magic comments
// for whole ecosystems: 88 of gin's 100 files read "Use of this source code is
// governed by a MIT style license…", every C file with an include read
// "include <stdio.h>", a Rust crate root read "!", a Ruby file
// "frozen_string_literal: true". The summary feeds BM25, repomap and onboard,
// so one license sentence made "license" match the whole repo.

const summary = (name: string, lines: string[]): string | undefined =>
  extractCode(name, name.slice(name.lastIndexOf(".")), lines.join("\n")).summary;

describe("file summary: license headers are not descriptions", () => {
  it("skips a Go license header, and finds the package doc below it", () => {
    const header = [
      "// Copyright 2014 Manu Martinez-Almeida. All rights reserved.",
      "// Use of this source code is governed by a MIT style",
      "// license that can be found in the LICENSE file.",
      "",
    ];
    expect(summary("gin.go", [...header, "package gin"])).toBeUndefined();
    expect(summary("doc.go", [...header, "// Package gin implements a HTTP web framework.", "package gin"])).toBe(
      "Package gin implements a HTTP web framework.",
    );
  });

  it("keeps the description a header puts after the license, in the same comment", () => {
    expect(
      summary("table_builder.h", [
        "// Copyright (c) 2011 The LevelDB Authors. All rights reserved.",
        "// Use of this source code is governed by a BSD-style license that can be",
        "// found in the LICENSE file. See the AUTHORS file for names of contributors.",
        "//",
        "// TableBuilder provides the interface used to build a Table",
        "// (an immutable and sorted map from keys to values).",
        "",
        "#ifndef STORAGE_LEVELDB_INCLUDE_TABLE_BUILDER_H_",
      ]),
    ).toBe("TableBuilder provides the interface used to build a Table (an immutable and sorted map from keys to values).");
  });

  it("skips every paragraph of MIT, BSD, Apache and GPL text, and reads the next comment", () => {
    const mit = [
      "/*",
      "  Copyright (c) 2009-2017 Dave Gamble and cJSON contributors",
      "",
      "  Permission is hereby granted, free of charge, to any person obtaining a copy",
      "  of this software and associated documentation files (the \"Software\"), to deal",
      "",
      "  The above copyright notice and this permission notice shall be included in",
      "  all copies or substantial portions of the Software.",
      "",
      '  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      "*/",
      "",
      "/* JSON parser in C. */",
      "#include <string.h>",
    ];
    expect(summary("cJSON.c", mit)).toBe("JSON parser in C.");
    const bsd = [
      "/*",
      " * Copyright (c) 1990 The Regents of the University of California.",
      " *",
      " * Redistribution and use in source and binary forms, with or without",
      " * modification, are permitted provided that the following conditions are met:",
      " *",
      " * 1. Redistributions of source code must retain the above copyright",
      " *    notice, this list of conditions and the following disclaimer.",
      " * 2. Neither the name of the University nor the names of its contributors",
      " */",
      "#include <sys/types.h>",
    ];
    expect(summary("qsort.c", bsd)).toBeUndefined();
    const apache = [
      "/*! *****************************************************************************",
      "Copyright (c) Microsoft Corporation. All rights reserved.",
      'Licensed under the Apache License, Version 2.0 (the "License"); you may not use',
      "this file except in compliance with the License.",
      "",
      "THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY",
      "KIND, EITHER EXPRESS OR IMPLIED.",
      "",
      "See the Apache Version 2.0 License for specific language governing permissions",
      "and limitations under the License.",
      "***************************************************************************** */",
      "",
      '/// <reference lib="es2016" />',
      "",
      "/////////////////////////////",
      "/// Worker APIs",
      "/////////////////////////////",
      "",
      "interface Worker {}",
    ];
    expect(summary("lib.webworker.d.ts", apache)).toBe("Worker APIs");
    const gpl = [
      "/* This file is part of GNU Foo.",
      "",
      "   GNU Foo is free software: you can redistribute it and/or modify",
      "   it under the terms of the GNU General Public License.  */",
      "",
      "/* Parse foo files.  */",
      "#include <config.h>",
    ];
    expect(summary("foo.c", gpl)).toBe("Parse foo files.");
    const angular = [
      "/**",
      " * @license",
      " * Copyright Google LLC All Rights Reserved.",
      " *",
      " * Use of this source code is governed by an MIT-style license that can be",
      " * found in the LICENSE file at https://angular.io/license",
      " */",
      "",
      "import {x} from './x';",
    ];
    expect(summary("core.ts", angular)).toBeUndefined();
  });

  it("still reads a library banner, and stops it at the license line", () => {
    expect(summary("jquery.js", ["/*!", " * jQuery JavaScript Library v3.6.0", " * Released under the MIT license", " */"])).toBe(
      "jQuery JavaScript Library v3.6.0",
    );
  });
});

describe("file summary: what counts as a comment depends on the language", () => {
  it("never reads a C preprocessor line as prose, and looks past an include guard or #pragma once", () => {
    expect(summary("d.c", ["#include <stdio.h>", "// Prints things.", "int main() {}"])).toBeUndefined();
    expect(summary("e.hpp", ["#pragma once", "// Widget API.", "class W {};"])).toBe("Widget API.");
    expect(summary("f.h", ["#ifndef F_H", "#define F_H", "/* Frame codec. */", "int f(void);"])).toBe("Frame codec.");
  });

  it("reads Rust crate docs, past an inner attribute", () => {
    expect(summary("lib.rs", ["//! Crate docs.", "pub fn a() {}"])).toBe("Crate docs.");
    expect(summary("lib.rs", ["#![allow(dead_code)]", "//! Crate docs here.", "pub fn a() {}"])).toBe("Crate docs here.");
    // An outer attribute belongs to the item below it: that comment is no file doc.
    expect(summary("m.rs", ["#[derive(Debug)]", "// A point.", "struct P;"])).toBeUndefined();
  });

  it("skips Ruby and Python magic comments", () => {
    expect(summary("a.rb", ["# frozen_string_literal: true", "", "# Handles requests.", "class Foo", "end"])).toBe(
      "Handles requests.",
    );
    expect(summary("b.rb", ["# typed: strict", "# frozen_string_literal: true", "", "module Foo", "end"])).toBeUndefined();
    expect(summary("c.py", ["# -*- coding: utf-8 -*-", "def f():", "    pass"])).toBeUndefined();
    expect(
      summary("d.py", ["#!/usr/bin/env python", "# -*- coding: utf-8 -*-", '"""Module docstring here."""', "import os"]),
    ).toBe("Module docstring here.");
  });

  it("reads PHP after its open tag, Lua and Haskell dash comments, and JS after a directive prologue", () => {
    expect(summary("p.php", ["<?php", "declare(strict_types=1);", "/**", " * Handles the cart.", " */", "namespace App;"])).toBe(
      "Handles the cart.",
    );
    expect(summary("m.lua", ["-- Lua module for strings.", "local M = {}"])).toBe("Lua module for strings.");
    expect(summary("Main.hs", ["{-# LANGUAGE OverloadedStrings #-}", "-- | The main module.", "module Main where"])).toBe(
      "The main module.",
    );
    expect(summary("w.tsx", ['"use client";', "/** A client widget. */", "export const x = 1;"])).toBe("A client widget.");
    expect(summary("g.js", ["/* global window, document */", "/** @description Recursive object extending. */"])).toBe(
      "Recursive object extending.",
    );
  });

  it("skips Xcode's name-project-author stamp, editor mode lines and bundler region markers", () => {
    const xcode = [
      "//",
      "//  AppDelegate.swift",
      "//  MyApp",
      "//",
      "//  Created by John on 12/3/19.",
      "//  Copyright © 2019 John. All rights reserved.",
      "//",
      "",
      "import UIKit",
    ];
    expect(summary("AppDelegate.swift", xcode)).toBeUndefined();
    expect(summary("Feed.swift", [...xcode.slice(0, 7), "//  Parses the feed.", "", "import UIKit"])).toBe("Parses the feed.");
    expect(summary("m.js", ["/* -*- Mode: js; js-indent-level: 2; -*- */", "var x = 1;"])).toBeUndefined();
    expect(summary("dist/a.mjs", ["//#region src/utils.ts", "/** Coerce `value`. */", "function c() {}"])).toBe("Coerce `value`.");
  });

  it("is a pure function of the extension and the text", () => {
    const src = ["# Deploys the app.", "set -e"].join("\n");
    expect(fileSummary(".sh", src)).toBe("Deploys the app.");
    // `#` is no comment in JS: the line is code, and nothing precedes it.
    expect(fileSummary(".js", src)).toBeUndefined();
  });
});

describe("symbol docs share the rules", () => {
  it("drops an Emacs coding line instead of documenting the first function with it", () => {
    const info = extractCode("c.py", ".py", ["# -*- coding: utf-8 -*-", "def f():", "    pass"].join("\n"));
    expect(info.symbols.find((s) => s.name === "f")?.doc).toBeUndefined();
    const documented = extractCode("c.py", ".py", ["# -*- coding: utf-8 -*-", "# Adds one.", "def f():", "    pass"].join("\n"));
    expect(documented.symbols.find((s) => s.name === "f")?.doc).toBe("Adds one.");
  });

  it("does not take prose for legal text or directives", () => {
    // A sentence that continues with "distributed under …" names no license.
    expect(summarizeDocLines(["Balances the work that is", "distributed under heavy load."])).toBe(
      "Balances the work that is distributed under heavy load.",
    );
    expect(summarizeDocLines(["Returns the key.", "Licensed under the MIT license."])).toBe("Returns the key.");
    // An ESLint `global` list is a directive; a sentence opening with "Global" is not.
    expect(isDirective("global window, document")).toBe(true);
    expect(isDirective("globals $: readonly")).toBe(true);
    expect(summarizeDocLines(["Global registry of handlers."])).toBe("Global registry of handlers.");
  });
});
