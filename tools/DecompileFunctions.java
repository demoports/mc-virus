// DecompileFunctions.java
// @category MC-Virus
// @author OpenAI

import java.io.File;
import java.io.PrintWriter;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;

/**
 * Small headless helper used while reconstructing mc-virus.gba.
 *
 * Usage:
 *   analyzeHeadless PROJECT_DIR PROJECT -process mc-virus.gba -noanalysis \
 *     -scriptPath tools -postScript DecompileFunctions.java OUT.c 0818034c ...
 */
public class DecompileFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) {
            throw new IllegalArgumentException("expected output path followed by one or more addresses");
        }

        DecompInterface decompiler = new DecompInterface();
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) {
            throw new IllegalStateException("could not open program in decompiler");
        }

        try (PrintWriter out = new PrintWriter(new File(args[0]))) {
            for (int i = 1; i < args.length; ++i) {
                Address address = toAddr(args[i]);
                Function function = getFunctionAt(address);
                if (function == null) {
                    // Raw GBA/IWRAM imports have no symbol table and many calls are made
                    // through copied function pointers, so auto-analysis cannot discover
                    // every entry point.  Seed explicitly requested addresses here.
                    disassemble(address);
                    function = createFunction(address, null);
                }
                if (function == null) {
                    function = getFunctionContaining(address);
                }

                out.println("/* ================================================================");
                out.println(" * " + args[i]);
                out.println(" * ================================================================ */");
                if (function == null) {
                    out.println("/* no function exists at this address */\n");
                    continue;
                }

                DecompileResults result = decompiler.decompileFunction(function, 120, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
                    out.println("/* decompilation failed: " + result.getErrorMessage() + " */\n");
                    continue;
                }
                out.println(result.getDecompiledFunction().getC());
                out.println();
            }
        }
        finally {
            decompiler.dispose();
        }
    }
}
