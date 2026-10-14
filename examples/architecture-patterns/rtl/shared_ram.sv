module reader(input wire [3:0] addr, output wire [3:0] request,
              input wire [7:0] response, output wire [7:0] result);
  assign request = addr;
  assign result = response;
endmodule
module dual_read_ram(input wire clk, we, input wire [3:0] wa, a_addr, b_addr,
                     input wire [7:0] wd, output wire [7:0] a_data, b_data);
  logic [7:0] mem[0:15];
  always_ff @(posedge clk) if (we) mem[wa] <= wd;
  assign a_data = mem[a_addr];
  assign b_data = mem[b_addr];
endmodule
module shared_ram(input wire clk, we, input wire [3:0] wa, addr_a, addr_b,
                  input wire [7:0] wd, output wire [7:0] out_a, out_b);
  wire [3:0] ra, rb;
  wire [7:0] da, db;
  reader reader_a(addr_a, ra, da, out_a);
  reader reader_b(addr_b, rb, db, out_b);
  dual_read_ram store(clk, we, wa, ra, rb, wd, da, db);
endmodule
