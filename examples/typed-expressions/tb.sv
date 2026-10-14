module tb;
  logic clk=0, rst_n=0, enable=0;
  logic signed [7:0] sample=0;
  logic [3:0] shift=0;
  wire signed [11:0] scaled;
  wire [7:0] packed_value, logical_value;
  wire negative, parity;
  signed_scaler dut(.*);
  rtlarch_contract_checks checks();
  task tick;
    #5; clk=1; #5; clk=0; #1;
  endtask
  initial begin
    tick(); rst_n=1; enable=1;
    for (int a=0; a<256; a++) begin
      for (int b=0; b<16; b++) begin
        sample=8'(a); shift=4'(b); tick();
        // Independent integer reference: arithmetic shift is floor division by 2^b.
        if (int'(scaled) != ((a<128 ? a : a-256) >>> b)) $fatal(1,"signed result");
        if (packed_value != 8'((a<128 ? a : a-256) >>> b)) $fatal(1,"low bits");
        if (logical_value != (a >> b) || negative != (a>=128) || parity != ^sample) $fatal(1,"flags/logical");
      end
    end
    enable=0; sample=0; shift=0; tick();
    $display("TYPED_EXHAUSTIVE_PASS 4096 input pairs plus reset and hold");
    $finish;
  end
endmodule
