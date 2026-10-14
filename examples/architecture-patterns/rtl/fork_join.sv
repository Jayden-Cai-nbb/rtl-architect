module add_one(input wire [7:0] din, output wire [7:0] dout);
  assign dout = din + 8'd1;
endmodule
module invert_byte(input wire [7:0] din, output wire [7:0] dout);
  assign dout = ~din;
endmodule
module join_xor(input wire [7:0] a, b, output wire [7:0] result);
  assign result = a ^ b;
endmodule
module fork_join(input wire [7:0] din, output wire [7:0] dout);
  wire [7:0] sum, inverted;
  add_one left(din, sum);
  invert_byte right(din, inverted);
  join_xor merge(sum, inverted, dout);
endmodule
